---
name: claude-relais
description: High-reasoning Claude Code orchestration skill with guarded PLAN->BUILD->JUDGE loops and optional Cursor headless builder acceleration.
---

# claude-relais

Use this skill when the user wants deterministic orchestration with strong guardrails and fast build execution.

## Default profile

- Orchestrator model: `opus-4.6`
- Builder mode: `cursor` when available
- Fallback builder mode: `claude_code`
- Contract model: orchestrator writes control contracts; builder writes code + `REPORT`

## Required contracts

- `relais/STATE.json`
- `relais/TASK.json`
- `relais/REPORT.json`

Optional contracts:

- `relais/ROADMAP.json`
- `relais/REVIEW.json`
- `relais/DESIGN-CONTRACT.json`

## Workflow

1. Read `relais/STATE.json` and determine role/phase.
2. Plan one bounded task with explicit write scope.
3. Execute build with chosen builder mode.
4. Judge by git truth + verification outputs.
5. Persist report and next state.

## Guardrails

- Enforce scope boundaries and forbidden files.
- Never trust builder claims without verification.
- Stop on unsafe diffs or failing verification.
- Keep cycles finite and restart-safe.

## References

- `references/how-it-works.md`
- `references/contracts.md`
- `references/configuration.md`
- `references/troubleshooting.md`
