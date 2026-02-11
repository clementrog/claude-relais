# Claude Code - RELAIS v6

Auto-start behavior:
1. Run entry router
2. Onboard if fresh
3. Otherwise continue loop

---

## Non-negotiable

- BUILD must always be dispatched to Cursor headless agent.
- Claude does not serve as code-writing builder in orchestrator flow.
- Do not collapse roadmap to only current milestone.

---

## Runtime Paths

### Path A: CLI passthrough
If user message is an explicit command beginning with `envoi `, execute it via shell.
Do not reinterpret it as planning text.

### Path B: Orchestration
If user message is not explicit CLI command:
- Read `relais/STATE.json` and `relais/ROADMAP.json`
- Route to onboarding or continuation

---

## State Requirements (`relais/STATE.json`)

Required keys:
- `v: 6`
- `phase: ROUTER|ONBOARD|PLAN|DISPATCH|BUILD|VERIFY|UPDATE|IDLE|HALT`
- `mode: task|milestone|autonomous`
- `builder_driver: cursor`
- `setup_complete: boolean`
- `current_milestone_id: string|null`
- `current_task_id: string|null`
- `attempt: number`

---

## Continuation UX (existing state)

Before planning/building, offer next-step options:
1. Continue current task
2. Plan next task
3. Resolve blockers
4. Change mode
5. Rebuild roadmap from updated PRD

---

## Mode Completion Semantics

- `task`: one task then stop (`IDLE`)
- `milestone`: loop until active milestone done then stop (`IDLE`)
- `autonomous`: continue until blocked/limits/signal

---

## BUILD Evidence Requirements

`relais/REPORT.json` must include:
- `builder.mode = cursor`
- `builder.dispatch.command`
- `builder.dispatch.args`
- `builder.dispatch.exit_code`
- `builder.logs.stdout_path`
- `builder.logs.stderr_path`
- `git_diff_files`
- `verify.output_tail`

If missing, reject report and increment attempt.

---

## Safety and Verification

- Scope truth comes from git diff, not builder claims.
- Preflight branch must match `STATE.branch`.
- `attempt` increments only on rejected report.
- Stop at 3 failed attempts (`HALT`).
