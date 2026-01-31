Revised spec: make “autonomous + milestone + patch + (Cursor-like) builder” true
Guiding decisions (from your review)

Do not implement dollar cost estimation in v1. Track counts only.

Do not implement repo summary generation (token bloat + complexity). Use git status + FACTS.md + last report.

Crash recovery: choose minimal diff:

Persist milestone_id early

Do not do a full write-ahead cost ledger yet (optional PR later)

Cursor integration is treated as external builder driver:

Works with any headless script you control (Cursor wrapper, llm CLI, etc.)

“Cursor” becomes a mode name meaning “external driver”, not the GUI app.

PR breakdown (small, surgical)
PR1 — STATE ledger + budget hard-cap in preflight
What becomes true

Budgets are real and enforced.

Milestone id persists.

Ledger survives restarts.

Files to add

src/types/workspace_state.ts (new)

export interface WorkspaceState {
  milestone_id: string | null;
  budgets: {
    ticks: number;
    orchestrator_calls: number;
    builder_calls: number;
    verify_runs: number;
  };
  budget_warning: boolean;
  last_run_id: string | null;
  last_verdict: string | null;
}


src/lib/workspace_state.ts (new)

readWorkspaceState(workspaceDir): WorkspaceState

writeWorkspaceState(workspaceDir, state): void

ensureMilestone(state, milestoneId): { state, changed }

applyDeltas(state, deltas): WorkspaceState

computeBudgetWarning(state, perMilestone, warnAtFraction): boolean

Files to modify

src/lib/preflight.ts (around the “M14 budget checks not implemented” section)

Replace placeholder with:

Read STATE.json

If any hard cap exceeded (ticks / orchestrator_calls / builder_calls / verify_runs):

return blocked: BLOCKED_BUDGET_CAP

Keep it deterministic and cheap.

src/commands/init.ts (where it writes the workspace skeleton)

Ensure it writes a valid STATE.json matching the new type.

(Optional) include budget_warning=false.

src/index.ts (doctor path, optional)

In doctor, show ledger summary (ticks/calls) + caps.

Budget model (v1, minimal)

Use counts only:

max_ticks

max_orchestrator_calls

max_builder_calls

max_verify_runs

Soft stop is PR2 (loop). PR1 is hard stop (preflight).

PR2 — relais loop with modes + SIGINT graceful exit
What becomes true

Autonomous and milestone modes exist as actual behavior.

New file

src/runner/loop.ts (new)

API

export type LoopMode = "milestone" | "autonomous";
export interface LoopOptions {
  mode: LoopMode;
  max_ticks?: number; // optional extra cap on top of budgets
}
export async function runLoop(config: Config, opts: LoopOptions): Promise<Report>;


Core behavior

stop_requested flag

On SIGINT/SIGTERM:

set stop_requested=true

abort current Claude Code invocation (SIGTERM child, SIGKILL after 1s)

persist REPORT.json with code=STOP_INTERRUPTED, verdict=stop

release lock and exit with code 130 (standard Unix: 128 + signal 2)

On second SIGINT: force exit immediately with code 130

Note: REPORT.md write failures are logged but don't block REPORT.json persistence.

Loop logic

Before each tick:

run preflight (existing)

if BLOCKED_*, exit

Run runTick(config) once

After tick:

read STATE

if budget_warning === true: break loop (soft stop)

if verdict is stop/blocked: break loop

if mode === milestone:

stop when either:

task emits control.action="stop" (PR5), OR

milestone changes (safety stop), OR

soft budget warning triggers

if mode === autonomous:

allow milestone changes:

archive previous milestone ledger

reset budgets for next milestone

Modify CLI

src/index.ts (near the existing run command)

Add command:

relais loop --mode milestone|autonomous [--max-ticks N]

This keeps relais run = per-task (single tick).

PR3 — Persist milestone_id early (minimal crash tolerance)
What becomes true

Crash mid-tick won’t lose milestone id.

On restart, loop knows what milestone it’s in.

Modify tick

src/runner/tick.ts (near start of runTick)

After orchestrator returns a Task:

call ensureMilestone(state, task.milestone_id)

if changed, write STATE immediately

Then proceed to build/judge/verify/report.

This matches your “best/simpler” recommendation.

(Optional later PR: write-ahead pending_builder=true before running builder. Not necessary for dogfood.)

PR4 — Patch builder mode (real + safe)
What becomes true

“patch mode exists” becomes operational and secure.

Modify builder

src/runner/builder.ts (at start of runBuilder)
Add:

if (task.builder.mode === "patch") {
  // 1) parse + validate patch paths
  // 2) scope-check each path (allowed + forbidden)
  // 3) apply via git apply with directory + unsafe-paths disabled
  // 4) return BuilderInvocationResult
}

Patch validation rules (v1)

Pre-parse unified diff headers: lines starting with +++ or ---

Extract path after a/ or b/

Reject if:

contains ..

starts with /

contains \0

resolves outside repo root

Scope-check:

must match task.scope.allowed_globs

must not match task.scope.forbidden_globs

Apply:

write patch to ${workspaceDir}/.tmp/patch.diff (runner-owned)

run:

git apply --whitespace=nowarn --unsafe-paths=false --directory=<repoRoot> <patchfile>

If apply fails → STOP + rollback through existing pipeline

Symlink / fuzzy match note

Symlink risk: patching a symlink target is tricky. Minimal mitigation:

Before apply: for each path, lstat and reject if it’s a symlink OR any parent segment is symlink.

This is a small helper in builder patch path, and it’s worth it.

PR5 — External builder driver (“cursor” mode) + timeout enforcement
What becomes true

“Cursor builder” claim becomes true if you provide a headless driver.

Safety remains: strict IO contract + timeout kill.

Config changes

src/types/config.ts (builder config section)
Add:

builder: {
  default_mode: "claude_code" | "patch" | "cursor";
  cursor?: {
    command: string;
    args: string[];
    timeout_seconds: number;
    output_file: string; // e.g. "relais/BUILDER_RESULT.json"
  };
}


src/lib/config.ts validate:

if default_mode == cursor, require cursor fields

enforce argv-only; no shell string

Task schema changes

relais/schemas/task.schema.json

builder.mode enum add "cursor"

src/types/task.ts

add "cursor" to TaskBuilder.mode

Runtime behavior

In src/runner/builder.ts:

If task.builder.mode === "cursor":

write ${workspaceDir}/TASK.json (full task)

spawn external driver:

execFile(config.builder.cursor.command, resolvedArgs, { timeout: timeout_seconds*1000 })

read output_file JSON and validate with builder_result.schema.json

return BuilderInvocationResult

Timeout rules

On timeout:

kill the child

return STOP: STOP_BUILDER_TIMEOUT

rollback (existing)

Important note (aligns with your review)

Cursor GUI is not assumed. The “cursor” mode is just “external driver mode”.

Your driver could be:

a private Cursor automation wrapper

a python script using an LLM CLI

anything deterministic enough to produce the result JSON

PR6 — Stop conditions (control.action) with exclusivity rule
What becomes true

Loop has a clean “done” signal.

Schema changes

relais/schemas/task.schema.json
Add:

"control": {
  "type": "object",
  "additionalProperties": false,
  "required": ["action"],
  "properties": {
    "action": { "type": "string", "enum": ["continue", "stop"] },
    "reason": { "type": "string", "maxLength": 400 }
  }
}


Exclusivity (your optimization):

A Task must be EITHER:

has control, and builder is absent, OR

has builder, and control is absent.

Enforce via schema oneOf:

oneOf: [{ required:["control"], not:{ required:["builder"] } }, { required:["builder"], not:{ required:["control"] } }]

Also update src/types/task.ts accordingly.

Loop behavior

If task.control.action == "stop": stop loop with success.

Prompt placeholder tightening (minimal, no repo summary)
What to implement

src/runner/orchestrator.ts (where placeholders are hardcoded today)
Replace the placeholder strings with:

git status --porcelain (tiny)

FACTS.md (if exists, else empty)

LAST_REPORT.md (if exists)

STATE.json milestone + budget remaining summary

Drop {{REPO_SUMMARY}} entirely (or leave as empty string).

This is the smallest change that makes multi-tick orchestration non-blind.

Acceptance tests (cheap but meaningful)

You can run these in dogfood immediately (and they map to your safety posture):

Loop stops on budget cap

Set budgets to tiny numbers, run relais loop, confirm preflight blocks on next tick.

SIGINT is graceful

Start relais loop

ctrl+c during orchestrator or verify phase

Confirm:

report exists

lock released

repo clean (or rolled back)

Patch path traversal rejected

Feed a patch with +++ b/../../evil

Confirm STOP before git apply.

External builder timeout kills child

Provide driver that sleeps longer than timeout

Confirm STOP_BUILDER_TIMEOUT + rollback

What I want from Gemini (feedback prompt)

Paste this verbatim to Gemini to confirm edge cases and keep him honest:

I’m implementing autonomous + milestone + patch + “Cursor builder” on top of relais with minimal diffs and unchanged safety posture.

Important: I am NOT assuming Cursor has a headless CLI. “cursor mode” means an external driver command (argv-only) that reads TASK.json and writes BUILDER_RESULT.json.

Please critique these specifics:

1) Crash recovery: I’m persisting milestone_id immediately after orchestrator returns. I’m NOT doing write-ahead budget cost to keep diffs minimal. Is there any crash scenario where this causes unsafe repeat builds or state corruption?

2) Budget enforcement: Hard-cap in preflight (BLOCKED_BUDGET_CAP) + soft-stop in loop (budget_warning triggers break). Would you also block if “next_tick worst case” exceeds cap? If yes, suggest a deterministic estimate.

3) Patch security: I will pre-parse unified diff headers, reject .. or absolute paths, reject symlinks (lstat), then apply via `git apply --unsafe-paths=false --directory=<repoRoot>`. Any other minimal must-haves?

4) Loop safety: In milestone mode, I will STOP if orchestrator changes milestone_id unexpectedly. In autonomous mode, I allow milestone changes but archive the previous milestone ledger and reset budgets. Any edge cases?

5) SIGINT: loop traps SIGINT, sets stop_requested flag, waits for tick promise to resolve, then exits. Any risk of deadlock? Should it still kill after a second SIGINT?

6) Schema: I’m adding `task.control.action=continue|stop` and enforcing oneOf exclusivity: control XOR builder. Any better minimal contract?

7) Minimal diffs: Which parts would you drop further? (I already dropped repo summary generation + dollar cost estimation.)
