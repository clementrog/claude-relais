# Envoi Polishing Plan — Dogfooding Ready

**Status:** Draft
**Owner:** Clement
**Reference:** [PRD v1](../prd/Envoi%20—%20PRD%20v1.md)
**Goal:** Make Envoi resilient to Cursor stalls + wire JUDGE + ship dogfood test battery

---

## Overview

After proving the core loop works (orchestrator → builder → basic verification), these are the gaps blocking comfortable dogfooding:

1. **Report files dirty the repo** — every tick modifies `envoi/REPORT.json`
2. **No `envoi init`** — manual setup required
3. **JUDGE phase incomplete** — scope/diff/verify guardrails not enforced from git reality
4. **Fixture coverage gaps** — need red/green tests for all STOP codes
5. **Transport stalls** — Cursor "Connection stalled", CLI hang, timeout not handled

---

## Global Acceptance Criteria

Envoi must:

1. **Never report SUCCESS** if it violated scope/diff/verify/head-moved rules
2. **Never leave the repo dirty** after a failed/blocked tick (rollback if configured/needed)
3. **Detect and classify transport stalls deterministically** (Cursor "Connection stalled", CLI hang, timeout)
4. **Provide deterministic recovery path**: retry bounded + degrade + then block for human

---

## M11: Report Output Hygiene ✅

**Problem:** `envoi/REPORT.json` dirties the worktree every tick, triggering `BLOCKED_DIRTY_WORKTREE` on next run.

**Reference:** PRD §3 STOP vs BLOCKED, §13 Atomicity

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-100 | Auto-add `.gitignore` entries during init | `envoi/REPORT.json`, `envoi/REPORT.md`, `envoi/history/**`, `envoi/*.tmp`, `envoi/lock.json` are gitignored |
| WP-101 | Exclude runner-owned files from dirty check | Preflight `BLOCKED_DIRTY_WORKTREE` ignores paths matching `runner_owned_globs` |

---

## M12: `envoi init` Command ✅

**Problem:** No scaffolding command exists. Users must manually create workspace.

**Reference:** PRD §15 CLI (V1): `envoi init`

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-110 | Implement `envoi init` basic scaffolding | Creates `envoi.config.json` if missing |
| WP-111 | Create workspace directory structure | Creates `envoi/` with subdirs: `prompts/`, `schemas/`, `history/` |
| WP-112 | Copy default prompts | Writes `orchestrator.system.txt`, `orchestrator.user.txt`, `builder.system.txt`, `builder.user.txt` |
| WP-113 | Copy default schemas | Writes `task.schema.json`, `builder_result.schema.json`, `report.schema.json` |
| WP-114 | Initialize STATE.json | Creates empty/initial `STATE.json` with milestone counter at 0 |
| WP-115 | Add .gitignore entries | Appends envoi ignores to `.gitignore` (or creates if missing) |
| WP-116 | Print next steps | CLI outputs: "Created envoi workspace. Next: edit envoi.config.json, then run `envoi run`" |

---

## M13: JUDGE Phase — Scope Guardrails ✅

**Problem:** Builder can touch forbidden paths, create files, modify lockfiles — no enforcement.

**Reference:** PRD §10 Judge (scope + diff + blast radius), Appendix A4

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-120 | Compute touched set from git | `git diff --name-status base_commit..HEAD` + `git status --porcelain` |
| WP-121 | Implement `STOP_RUNNER_OWNED_MUTATION` | Any path under `runner_owned_globs` touched → STOP + rollback |
| WP-122 | Implement `STOP_SCOPE_VIOLATION_FORBIDDEN` | Any path matching `forbidden_globs` touched → STOP + rollback |
| WP-123 | Implement `STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED` | Any path not matching `allowed_globs` touched → STOP + rollback |
| WP-124 | Implement `STOP_SCOPE_VIOLATION_NEW_FILE` | New file created when `allow_new_files=false` → STOP + rollback |
| WP-125 | Implement `STOP_LOCKFILE_CHANGE_FORBIDDEN` | Lockfile touched when `allow_lockfile_changes=false` → STOP + rollback |

---

## M14: JUDGE Phase — Diff Limits ✅

**Problem:** Builder can make massive changes without limit enforcement.

**Reference:** PRD §10 Judge, config `diff_limits`

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-130 | Compute blast radius | `files_touched`, `lines_added`, `lines_deleted`, `new_files` from git diff |
| WP-131 | Implement `STOP_DIFF_TOO_LARGE` | `files_touched > max_files_touched` OR `lines_changed > max_lines_changed` → STOP + rollback |
| WP-132 | Write blast radius to REPORT.json | Report includes `blast_radius` object per schema |

---

## M15: JUDGE Phase — Verification Safety ✅

**Problem:** Verification commands not validated for injection; failures not enforced.

**Reference:** PRD §11 Verification (safe, bounded), Appendix A5

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-140 | Validate verification params | Reject: len > 128, whitespace, `..`, metachar regex match |
| WP-141 | Implement `STOP_VERIFY_TAINTED` | Any param fails validation → STOP before execution |
| WP-142 | Implement `STOP_VERIFY_FAILED_FAST` | Fast verify exits non-zero → STOP, skip slow |
| WP-143 | Implement `STOP_VERIFY_FAILED_SLOW` | Slow verify exits non-zero → STOP |
| WP-144 | Implement `STOP_VERIFY_FLAKY_OR_TIMEOUT` | Verify command times out → STOP |
| WP-145 | Implement `STOP_VERIFY_ONLY_SIDE_EFFECTS` | `task_kind=verify_only` but git diff exists → STOP + rollback |
| WP-146 | Implement `STOP_QUESTION_SIDE_EFFECTS` | `task_kind=question` but git diff exists → STOP + rollback |

---

## M16: JUDGE Phase — Head Moved Detection ✅

**Problem:** External git changes during tick not detected.

**Reference:** PRD Appendix A4 priority 9

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-150 | Record base_commit at tick start | Store in STATE or tick context |
| WP-151 | Implement `STOP_HEAD_MOVED` | HEAD changed externally (not by builder diff) → STOP |

---

## M17: Rollback Implementation ✅

**Problem:** STOP codes documented to rollback, but rollback not implemented.

**Reference:** PRD Appendix B — Rollback rules

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-160 | Implement rollback function | `git reset --hard <base_commit>` + remove untracked touched paths |
| WP-161 | Assert clean after rollback | `git diff --exit-code` + no untracked in touched set |
| WP-162 | Integrate rollback into STOP handlers | All scope/diff/verify STOPs trigger rollback before report |

---

## M18: Transport Stall Handling (Cursor/CLI hang, Connection stalled)

**Problem:** If builder/orchestrator invocation stalls or throws "connection stalled", Envoi must handle it deterministically.

**Goal:** Detect and classify transport stalls, stop the tick with `BLOCKED_TRANSPORT_STALLED`, record evidence, release lock, ensure repo is clean.

### Required Behavior

When stall detected:
1. Stop the tick with `BLOCKED_TRANSPORT_STALLED`
2. Record evidence (stage, request_id, error snippet)
3. Release lock
4. Ensure repo is clean (rollback if dirty / unknown side effects)

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-210 | Add `BLOCKED_TRANSPORT_STALLED` blocked code | New blocked code in types/report.ts or types/blocked.ts |
| WP-211 | Add hard timeout wrapper for Claude invocations | Wrap orchestrator + builder calls with configurable timeout per phase |
| WP-212 | Implement error normalization for stalls | Detect substrings: "Connection stalled", "Request ID:", "streamFromAgentBackend" |
| WP-213 | Return structured stall failure | Return `{ kind: 'transport_stalled', stage, request_id, raw_error }` |
| WP-214 | Handle stall in tick runner | If stall during ORCHESTRATE or BUILD: rollback if dirty, write report, exit blocked |
| WP-215 | Add heartbeat file for watchdog (optional) | `.git/envoi/heartbeat.json` updated at phase boundaries |

### Detection Patterns

```
Connection stalled
Request ID:
streamFromAgentBackend
```

### Files Touched

- `src/types/report.ts` or `src/types/blocked.ts` (new code)
- `src/lib/claude.ts` (timeout + error parsing)
- `src/lib/tick.ts` (stall handling)
- `src/lib/blocked.ts` (message strings)

### Verification Commands

```bash
pnpm test
pnpm typecheck
```

### Commit Message

```
M18: handle transport stalls deterministically (timeout + evidence + safe rollback)
```

---

## M19: Wire JUDGE into Tick Runner

**Problem:** JUDGE functions exist but aren't called in the actual tick execution flow.

**Reference:** PRD §10 Judge

**Goal:** After BUILD completes, compute touched paths, enforce scope/diff/verify/head-moved, rollback on STOP, only return SUCCESS if all checks pass.

### Required Behavior

After BUILD completes:
1. Compute touched paths + blast radius (files/lines/new files)
2. Enforce scope: forbidden globs, outside allowed, new files if not allowed, lockfile changes if not allowed
3. Enforce diff limits
4. Enforce head moved
5. Run verify templates (fast then slow) using argv_no_shell safety
6. If any STOP condition: set correct report code, rollback, release lock, return STOP verdict
7. Only return SUCCESS if all checks pass

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-170 | Create `src/lib/tick.ts` with `runTick()` function | Orchestrates full tick: preflight → orchestrator → builder → judge → report |
| WP-171 | Integrate `getTouchedFiles()` after builder | Compute touched files from base commit |
| WP-172 | Integrate `checkScopeViolations()` | Call with touched files and task scope, rollback on violation |
| WP-173 | Integrate `checkDiffLimits()` | Call with blast radius and config limits, rollback on violation |
| WP-174 | Integrate `checkHeadMoved()` | Verify HEAD hasn't moved externally |
| WP-175 | Integrate `validateAllParams()` before verify | Reject tainted params before execution |
| WP-176 | Wire rollback on any STOP | All STOP codes trigger `rollbackToCommit()` before writing report |
| WP-177 | Write REPORT.json with judge results | Include stop_code, blast_radius, violated_files in report |

### Acceptance Tests

- Existing F010_forbidden_edit flips from SUCCESS → STOP (scope violation)
- A verify failure fixture produces STOP_VERIFY_FAILED_FAST / SLOW
- Head moved fixture produces STOP_HEAD_MOVED
- Diff too large fixture produces STOP_DIFF_TOO_LARGE

### Verification Commands

```bash
pnpm test
pnpm typecheck
```

### Commit Message

```
M19: wire JUDGE into tick runner (scope/diff/verify/head-moved/rollback)
```

---

## M20: Dogfood Fixture Battery (F020–F100)

**Problem:** Need integration tests that exercise the full tick with JUDGE enforcement.

**Reference:** PRD Appendix A4, Appendix B

**Goal:** Create deterministic fixtures that prove Envoi stops correctly.

### Fixtures (Minimum Set)

| Fixture | Scenario | Expected Code |
|---------|----------|---------------|
| F020 | Edit `docs/notes.md` while `allowed_globs=["src/**"]` | `STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED` |
| F030 | Create `src/new.js` while `allow_new_files=false` | `STOP_SCOPE_VIOLATION_NEW_FILE` |
| F040 | Modify `pnpm-lock.yaml` while `allow_lockfile_changes=false` | `STOP_LOCKFILE_CHANGE_FORBIDDEN` |
| F050 | Append 500 lines to file with small diff limit | `STOP_DIFF_TOO_LARGE` |
| F060 | Verify param contains `;` or shell metachar | `STOP_VERIFY_TAINTED` |
| F070 | Fast verify exits 1 | `STOP_VERIFY_FAILED_FAST` |
| F080 | `task_kind=question` but builder edits file | `STOP_QUESTION_SIDE_EFFECTS` |
| F090 | Builder edits runner-owned path | `STOP_RUNNER_OWNED_MUTATION` |
| F100 | Builder/orchestrator stall | `BLOCKED_TRANSPORT_STALLED` |

### Harness Behavior

Each fixture run must:
1. Start from clean baseline (use rollback/reset in harness)
2. Remove/ignore runner reports so they don't dirty worktree between runs
3. Assert exact report code + verdict

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-180 | Create fixture test harness | Helper to run tick with mock config/task and assert result |
| WP-181 | F020: outside_allowed | Edit file outside `allowed_globs` → `STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED` |
| WP-182 | F030: new_file_forbidden | Create file when `allow_new_files=false` → `STOP_SCOPE_VIOLATION_NEW_FILE` |
| WP-183 | F040: lockfile_touched | Modify lockfile when forbidden → `STOP_LOCKFILE_CHANGE_FORBIDDEN` |
| WP-184 | F050: diff_too_large | Exceed line limit → `STOP_DIFF_TOO_LARGE` |
| WP-185 | F060: verify_tainted | Param with shell metachar → `STOP_VERIFY_TAINTED` |
| WP-186 | F070: verify_fail_fast | Fast verify exits 1 → `STOP_VERIFY_FAILED_FAST` |
| WP-187 | F080: question_side_effects | Question task with file edit → `STOP_QUESTION_SIDE_EFFECTS` |
| WP-188 | F090: runner_owned_mutation | Edit runner-owned path → `STOP_RUNNER_OWNED_MUTATION` |
| WP-189 | F100: transport_stall | Builder/orchestrator stall → `BLOCKED_TRANSPORT_STALLED` |

### Verification Commands

```bash
pnpm test
```

### Commit Message

```
M20: add red/green fixture battery (F020–F100)
```

---

## M21: Orchestrator Recovery Policy for Transport Stalls

**Problem:** When a stall happens repeatedly, orchestrator must not loop forever.

**Goal:** Bounded retry + degrade policy to prevent infinite loops.

### Recovery Policy (Hard Requirements)

| Attempt | Action |
|---------|--------|
| 1 | Retry same task unchanged |
| 2 | Retry with degraded settings: lower max_turns, stricter diff limits, prefer patch mode (if available) |
| 3 | Block and require human action |

### State Representation

`STATE.json` gets:
- `retry_count`
- `last_error_kind`
- `last_request_id`

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-220 | Add retry state fields to STATE.json | `retry_count`, `last_error_kind`, `last_request_id` fields |
| WP-221 | Implement retry policy in tick runner | Attempt 1: retry unchanged; Attempt 2: degrade; Attempt 3: block |
| WP-222 | Implement degraded settings | Lower max_turns, stricter diff_limits, prefer patch mode |
| WP-223 | Add recovery prompt to orchestrator | Include: "Do not assume previous edits were applied; read files first." |
| WP-224 | Reset retry state on success | Clear retry_count and error fields after successful tick |

### Verification Commands

```bash
pnpm test
pnpm typecheck
```

### Commit Message

```
M21: bounded retry + degrade policy for transport stalls
```

---

## M22: CLI Commands (`run`, `status`, `doctor`)

**Problem:** Only `init` command exists. Need full CLI for dogfooding.

**Reference:** PRD §15 CLI (V1)

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-190 | Implement `envoi run` command | Execute one tick, print result, exit with appropriate code |
| WP-191 | Add `--dry-run` flag to run | Show what would happen without executing |
| WP-192 | Add `--continue` flag to run | Resume from BLOCKED state if possible |
| WP-193 | Implement `envoi status` command | Show current STATE.json: phase, task, milestone, blockers |
| WP-194 | Add `--preflight` flag to status | Run preflight checks and report results |
| WP-195 | Add `--json` flag to status | Output machine-readable JSON |
| WP-196 | Implement `envoi doctor` command | Check prerequisites: git, claude CLI, node version |
| WP-197 | Doctor checks config validity | Validate envoi.config.json against schema |
| WP-198 | Doctor checks workspace integrity | Verify prompts/schemas exist, STATE.json valid |

---

## M23: Verification Execution

**Problem:** Verification commands exist in config but aren't executed after builder.

**Reference:** PRD §11 Verification

### Tasks

| ID | Task | Acceptance |
|----|------|------------|
| WP-200 | Implement `runVerification()` in tick | Execute verify commands from task after builder |
| WP-201 | Handle fast vs slow verification | Run fast first, skip slow if fast fails |
| WP-202 | Implement timeout handling | Kill command after `timeout_fast_seconds` / `timeout_slow_seconds` |
| WP-203 | Capture verification output | Store stdout/stderr in REPORT.json verify_history |
| WP-204 | Implement `STOP_VERIFY_FAILED_FAST` | Fast verify exits non-zero → STOP |
| WP-205 | Implement `STOP_VERIFY_FAILED_SLOW` | Slow verify exits non-zero → STOP |
| WP-206 | Implement `STOP_VERIFY_FLAKY_OR_TIMEOUT` | Timeout → STOP with classification |

---

## Implementation Order

**Phase 1 — Transport Resilience:**
1. **M18** (WP-210–215) — Transport stall handling
2. **M21** (WP-220–224) — Recovery policy (bounded retry + degrade)

**Phase 2 — Core Wiring:**
3. **M19** (WP-170–177) — Wire JUDGE into tick runner
4. **M23** (WP-200–206) — Verification execution

**Phase 3 — Validation:**
5. **M20** (WP-180–189) — Fixture test battery (F020–F100)

**Phase 4 — CLI Polish:**
6. **M22** (WP-190–198) — CLI commands

**Dependencies:**
- M18 enables M21 (stall handling before retry policy)
- M19 requires M13, M14, M15, M16, M17 (all JUDGE functions) ✅ done
- M20 requires M18 + M19 + M21 (full tick with stall handling)
- M22 requires M19 (tick runner)
- M23 requires M19 (tick runner)

---

## Fixture Summary

Complete test battery for JUDGE phase + transport stalls:

| ID | Name | Tests | Expected Code |
|----|------|-------|---------------|
| F000 | success | Happy path | `SUCCESS` |
| F010 | forbidden_edit | Edit `.git/config` | `STOP_SCOPE_VIOLATION_FORBIDDEN` |
| F020 | outside_allowed | Edit `docs/notes.md` (allowed=`src/**`) | `STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED` |
| F030 | new_file_forbidden | Create file (allow_new_files=false) | `STOP_SCOPE_VIOLATION_NEW_FILE` |
| F040 | lockfile_touched | Modify lockfile | `STOP_LOCKFILE_CHANGE_FORBIDDEN` |
| F050 | diff_too_large | 500 lines changed (limit=400) | `STOP_DIFF_TOO_LARGE` |
| F060 | verify_tainted | Param with `;` | `STOP_VERIFY_TAINTED` |
| F070 | verify_fail_fast | Fast verify exits 1 | `STOP_VERIFY_FAILED_FAST` |
| F080 | question_side_effects | question task + file edit | `STOP_QUESTION_SIDE_EFFECTS` |
| F090 | runner_owned_mutation | Edit `envoi/history/...` | `STOP_RUNNER_OWNED_MUTATION` |
| F100 | transport_stall | Builder/orchestrator stall | `BLOCKED_TRANSPORT_STALLED` |

---

## Notes

- Each WP task should be LOW risk, independently shippable
- Builder should run `pnpm test` after each task
- Orchestrator should verify git diff matches expected scope before merge
- One milestone = one commit
- Never refactor unrelated code — prefer minimal diffs
- After every milestone: run verification commands and paste results into final report
- If anything fails, fix before moving on
