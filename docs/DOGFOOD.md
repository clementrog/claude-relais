# Envoi Dogfooding Playbook

A step-by-step guide for running Envoi on external repositories to validate PRD invariants.

## Core Invariant

**`envoi tick` executes exactly one finite tick.** No retries, no loops, no "just one more try". Each run is deterministic and bounded.

---

## 1. Installation & Linking

### Option A: Install from npm/pnpm/yarn/bun

```bash
# From the envoi repo root
pnpm build
pnpm link --global  # or: npm link, yarn link, bun link
```

### Option B: Link locally (development)

```bash
# In envoi repo root
pnpm link

# In target repo root
pnpm link envoi  # or: npm link envoi, yarn link envoi, bun link envoi
```

### Option C: Use node_modules directly

```bash
# In target repo root
npm install /path/to/envoi
# or
pnpm add /path/to/envoi
```

**Note:** Target repo may use any package manager (npm, pnpm, yarn, bun). Envoi detects the package manager automatically during `envoi start`.

---

## 2. Initialization

### Quickstart (recommended): `envoi brief`

If you have a PRD ready, the simplest flow is:

```bash
envoi brief
```

It will:
- run `envoi start` if needed
- use PRD input in this order: `--prd-file`, piped stdin, local PRD discovery (`PRD.md`, `docs/PRD.md`, etc.), then editor fallback
- ask you to choose a loop mode (task|milestone|autonomous)
- ask you to choose a builder (claude_code vs cursor driver)

You can change choices later with:

```bash
envoi mode
envoi builder
envoi autonomy
```

### Capture ideas between boundaries

```bash
envoi idea "We should expose a quick preview path" --testability soon
```

Ideas are saved into `envoi/STATE.json` and provided to the orchestrator on future ticks for PM-style planning decisions.

### Updating `envoi` in-place (from any repo)

```bash
envoi update --dry-run
envoi update --yes
```

`envoi update` auto-detects linked-development installs vs registry installs, then runs the appropriate update command.

#### Cursor CLI `command` (if Cursor isn't detected)

Envoi writes a default Cursor driver config (`builder.cursor.command: "cursor"`). If `envoi check` warns that Cursor isn't found, set `builder.cursor.command` to the Cursor CLI path. On macOS it is often:

- `/Applications/Cursor.app/Contents/Resources/app/bin/cursor`

Quick checks:

- `which cursor`
- `cursor agent --help`

### Step 1: Navigate to target repo

```bash
cd /path/to/target-repo
```

### Step 2: Run `envoi start`

```bash
envoi start
```

This creates:
- `envoi.config.json` (auto-detects package manager and adjusts verification templates)
- `envoi/` directory with prompts, schemas, STATE.json
- Updates `.gitignore` to exclude `envoi/` artifacts
- Creates `envoi/PRD.md` and `envoi/FACTS.md` placeholders

**Force overwrite existing files:**
```bash
envoi start --force
```

**Custom workspace directory:**
```bash
envoi start --workspace-dir custom-dir
```

### Step 3: Run `envoi check`

```bash
envoi check
```

Checks:
- ✅ Config file exists and is valid JSON
- ✅ Config structure matches schema
- ✅ Git is available (if `require_git: true`)
- ✅ Claude Code CLI is available
- ✅ Cursor Agent is available + authenticated (when cursor builder is configured/selected)
- ✅ Workspace directory exists
- ✅ Prompts and schemas are present

**Fix any issues before proceeding.**

If a tick blocks at `BLOCKED_ORCHESTRATOR_OUTPUT_INVALID`, inspect:
- `envoi/BLOCKED.json` (high-level reason + remediation)
- `envoi/history/<run_id>/orchestrator/stdout.txt` and `envoi/history/<run_id>/orchestrator/stderr.txt` (raw CLI output)

---

## 3. Configuration

### 3.1 Verification Templates

Envoi auto-detects your package manager during `init` and adjusts verification templates. Manual override:

#### pnpm (workspace)

```json
{
  "verification": {
    "templates": [
      {
        "id": "test",
        "cmd": "pnpm",
        "args": ["-w", "test"]
      },
      {
        "id": "lint",
        "cmd": "pnpm",
        "args": ["-w", "lint"]
      }
    ]
  }
}
```

#### pnpm (non-workspace)

```json
{
  "verification": {
    "templates": [
      {
        "id": "test",
        "cmd": "pnpm",
        "args": ["test"]
      }
    ]
  }
}
```

#### npm

```json
{
  "verification": {
    "templates": [
      {
        "id": "test",
        "cmd": "npm",
        "args": ["test"]
      }
    ]
  }
}
```

#### yarn

```json
{
  "verification": {
    "templates": [
      {
        "id": "test",
        "cmd": "yarn",
        "args": ["test"]
      }
    ]
  }
}
```

#### bun

```json
{
  "verification": {
    "templates": [
      {
        "id": "test",
        "cmd": "bun",
        "args": ["test"]
      }
    ]
  }
}
```

**Template parameters (for filtering):**

```json
{
  "id": "test_filter",
  "cmd": "pnpm",
  "args": ["test", "--filter", "{{pkg}}"],
  "params": {
    "pkg": { "kind": "string_token" }
  }
}
```

**Safety:** All verification commands use `argv_no_shell` mode. No shell injection possible.

---

### 3.2 Cursor Builder Driver

If using `builder.default_mode: "cursor"` or task requests `builder.mode: "cursor"`:

```json
{
  "builder": {
    "default_mode": "cursor",
    "cursor": {
      "driver_kind": "cursor_agent",
      "command": "cursor",
      "args": ["agent", "--print", "--output-format", "text", "--workspace", ".", "--force"],
      "timeout_seconds": 300,
      "output_file": "BUILDER_RESULT.json"
    }
  }
}
```

Authentication:

- If you see auth errors, run `cursor agent login` (OAuth) or set `CURSOR_API_KEY` in your environment.
- Prefer env vars for keys; do not store secrets in `envoi.config.json`.

**Failure codes:**
- `BLOCKED_MISSING_CONFIG` → task requested `builder.mode: "cursor"` but `builder.cursor` is not configured
- `BLOCKED_BUILDER_COMMAND_NOT_FOUND` → `builder.cursor.command` not found in PATH / not executable
- `STOP_BUILDER_TIMEOUT` → Driver exceeded `timeout_seconds`
- `STOP_BUILDER_CLI_ERROR` → Driver exited non-zero or spawn failed
- `STOP_BUILDER_JSON_PARSE` → Output file is invalid JSON
- `STOP_BUILDER_SCHEMA_INVALID` → Output doesn't match `builder_result.schema.json`
- `STOP_BUILDER_SHAPE_INVALID` → Output is missing required fields (fallback validation)

**How it works:**
1. Runner writes `envoi/TASK.json` (full task JSON)
2. Runner spawns `cursor.command` with `cursor.args`
3. Driver reads `envoi/TASK.json`, executes task, writes `cursor.output_file`
4. Runner reads and validates output file
5. Runner judges changes via git diff

---

### 3.3 Git Branching

Configure automatic branch creation:

#### Per-tick (one branch per tick)

```json
{
  "git": {
    "branching": {
      "mode": "per_tick",
      "name_template": "envoi/{{task_id}}",
      "base_ref": "HEAD"
    }
  }
}
```

#### Per N tasks (batch branches)

```json
{
  "git": {
    "branching": {
      "mode": "per_n_tasks",
      "n_tasks": 5,
      "name_template": "envoi/batch-{{seq}}",
      "base_ref": "main"
    }
  }
}
```

#### Per milestone (one branch per milestone)

```json
{
  "git": {
    "branching": {
      "mode": "per_milestone",
      "name_template": "envoi/{{milestone_id}}",
      "base_ref": "main"
    }
  }
}
```

**Template placeholders:**
- `{{task_id}}` - Task ID from TASK.json
- `{{milestone_id}}` - Milestone ID
- `{{run_id}}` - Unique run ID
- `{{tick_count}}` - Tick counter
- `{{seq}}` or `{{batch_index}}` - Batch index (per_n_tasks only)
- `{{YYYYMMDD}}` - Date (YYYYMMDD format)

**Branching only applies to `task_kind: "execute"` tasks.** `verify_only` and `question` tasks run on current branch.

---

## 4. Running Envoi

### One Tick: `envoi tick`

```bash
envoi tick
```

Executes exactly one tick:
1. LOCK → PREFLIGHT → ORCHESTRATE → BUILD → JUDGE → REPORT → END
2. Writes `envoi/REPORT.json` and `envoi/REPORT.md`
3. Exits with code 0 (SUCCESS) or non-zero (STOP/BLOCKED)

**Dry run (preflight only):**
```bash
envoi tick --dry-run
```

**Continue from BLOCKED:**
```bash
envoi tick --continue
```

---

### Loop Mode: `envoi loop`

#### Task mode (stop after one task)

```bash
envoi loop --mode task
```

#### Milestone mode (stop when milestone completes or changes)

```bash
envoi loop --mode milestone
```

#### Autonomous mode (allow milestone changes, archive budgets)

```bash
envoi loop --mode autonomous
```

**Max ticks cap:**
```bash
envoi loop --mode milestone --max-ticks 10
```

**Stop conditions:**
- `blocked` - Preflight failed (BLOCKED_*)
- `budget_warning` - Budgets hit 80% threshold
- `sigint` - User interrupted (Ctrl+C)
- `verdict` - Tick returned STOP (non-success)
- `max_ticks` - Hit `--max-ticks` limit
- `milestone_change` - Milestone ID changed (task/milestone modes)
- `orchestrator_stop` - Orchestrator returned `control.action: "stop"`

---

## 5. Troubleshooting

### BLOCKED States

**`BLOCKED_DIRTY_WORKTREE`**
- **Fix:** `git status` → commit or stash changes, then retry

**`BLOCKED_LOCK_HELD`**
- **Fix:** Check `envoi/lock.json` → if stale (PID not running), delete it manually

**`BLOCKED_MISSING_CONFIG`**
- **Fix:** Ensure `envoi.config.json` exists and is valid JSON

**`BLOCKED_BUDGET_EXHAUSTED`**
- **Fix:** Check `envoi/STATE.json` → budgets exhausted, need to reset milestone

**`BLOCKED_CRASH_RECOVERY_REQUIRED`**
- **Fix:** Delete `envoi/*.tmp` files, validate `envoi/STATE.json` is valid JSON

**`BLOCKED_BUILDER_COMMAND_NOT_FOUND`**
- **Fix:** Ensure `builder.cursor.command` exists in PATH or use absolute path

---

### STOP States

**`STOP_SCOPE_VIOLATION_*`**
- **Cause:** Builder touched files outside `allowed_globs` or inside `forbidden_globs`
- **Fix:** Adjust scope in `envoi.config.json` or fix task scope

**`STOP_DIFF_TOO_LARGE`**
- **Cause:** Changes exceed `max_files_touched` or `max_lines_changed`
- **Fix:** Increase limits in config or split task into smaller chunks

**`STOP_VERIFY_FAILED_*`**
- **Cause:** Verification command exited non-zero or timed out
- **Fix:** Fix failing tests/lints, or adjust verification templates/timeouts

**`STOP_BUILDER_TIMEOUT`**
- **Cause:** Builder (Claude Code or cursor driver) exceeded timeout
- **Fix:** Increase `builder.claude_code.max_turns` timeout or `builder.cursor.timeout_seconds`

**`STOP_HEAD_MOVED`**
- **Cause:** External process moved HEAD during tick
- **Fix:** Ensure no other git operations run concurrently

---

### Rollback Cleanliness

On STOP (after builder ran), Envoi automatically:
1. `git reset --hard <base_commit>`
2. Removes untracked files that were touched
3. Verifies clean worktree: `git diff --exit-code` and no untracked files

**If rollback fails:**
- Check `envoi/REPORT.json` → `code: "BLOCKED_ROLLBACK_FAILED"` or `BLOCKED_ROLLBACK_DIRTY`
- Manually: `git reset --hard <base_commit>` and clean untracked files

---

## 6. Validation Checklist

After each run, verify:

### ✅ Artifacts Exist

- [ ] `envoi/REPORT.json` exists and is valid JSON
- [ ] `envoi/REPORT.md` exists (if `render_report_md.enabled: true`)
- [ ] `envoi/STATE.json` updated with budgets and phase
- [ ] `envoi/history/<run_id>/` contains snapshot (if history enabled)

### ✅ Report Contents

- [ ] `report.verdict` is `"success"`, `"stop"`, or `"blocked"`
- [ ] `report.code` matches expected (SUCCESS, STOP_*, BLOCKED_*)
- [ ] `report.blast_radius` matches `git diff --stat`
- [ ] `report.scope.ok` is `true` (or violations are expected)
- [ ] `report.verification.runs` shows all verification commands executed

### ✅ Git State

- [ ] On STOP: repo is clean (rolled back to `base_commit`)
- [ ] On SUCCESS: changes are committed or staged as expected
- [ ] Branch matches `git.branching.mode` expectations (if enabled)
- [ ] No untracked files from builder (except allowed)

### ✅ Budgets

- [ ] `envoi/STATE.json.budgets` incremented correctly
- [ ] Budget warnings appear at 80% threshold
- [ ] Budgets don't exceed `budgets.per_milestone` limits

### ✅ BLOCKED Handling

- [ ] `envoi/BLOCKED.json` exists when `verdict: "blocked"`
- [ ] `BLOCKED.json` contains `code` and `remediation` fields
- [ ] Repo is clean (no partial changes)

### ✅ History (if enabled)

- [ ] `envoi/history/<run_id>/meta.json` exists
- [ ] `envoi/history/<run_id>/report.json` matches `envoi/REPORT.json`
- [ ] `envoi/history/<run_id>/diff.patch` exists (if `include_diff_patch: true`)
- [ ] `envoi/history/<run_id>/verify.log` exists (if `include_verify_log: true`)

---

## 7. Example Workflow

```bash
# 1. Install and link
cd /path/to/envoi
pnpm build && pnpm link --global

# 2. Initialize target repo
cd /path/to/target-repo
envoi start
envoi check

# 3. Configure (edit envoi.config.json)
# - Set verification templates for your package manager
# - Configure git.branching if needed
# - Set builder mode (claude_code or cursor)

# 4. Run one tick
envoi tick

# 5. Check results
cat envoi/REPORT.json | jq '.verdict, .code, .blast_radius'
git status

# 6. Run loop (if needed)
envoi loop --mode milestone
```

---

## 8. PRD Invariants to Validate

### G1: Determinism of Effects
- ✅ Every tick starts from `base_commit`
- ✅ Every tick ends with recorded blast radius from git
- ✅ No hidden retries (attempt limits enforced)

### G2: Safety by Default
- ✅ Scope fencing is strict (STOP on violation)
- ✅ Runner-owned files are sacred (STOP on mutation)

### G3: One Tick Only
- ✅ `envoi tick` is finite (no loops)
- ✅ Hard attempt limits enforced

### G4: Token/Usage Discipline
- ✅ Hard caps on turns and prompt size
- ✅ Budget gates before spending

### G5: OSS-Friendly
- ✅ Config is one file (`envoi.config.json`)
- ✅ Fixtures define contract (CI-ready)

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `envoi start` | Initialize workspace |
| `envoi check` | Check configuration |
| `envoi tick` | Execute one tick |
| `envoi loop --mode task` | Run until task completes |
| `envoi loop --mode milestone` | Run until milestone completes |
| `envoi loop --mode autonomous` | Run autonomously |

| File | Purpose |
|------|---------|
| `envoi.config.json` | Configuration |
| `envoi/STATE.json` | Current state and budgets |
| `envoi/TASK.json` | Current task (runner-owned) |
| `envoi/REPORT.json` | Tick report (canonical) |
| `envoi/REPORT.md` | Human-readable report |
| `envoi/BLOCKED.json` | Blocked state (if applicable) |
| `envoi/history/<run_id>/` | History snapshot |

---

**Questions?** Check `envoi/REPORT.json` → `report.code` and `report.budgets.warnings` for details.
