---
name: claude-relais
description: High-reasoning orchestration skill for Claude Code that runs guarded PLAN->BUILD->JUDGE loops with Cursor headless builder enforcement.
---

# claude-relais

Use this skill when the user wants an orchestration loop with strong guardrails, explicit contracts, and fast delivery.

## Default execution profile

- Orchestrator reasoning: Claude Opus (`opus-4.6` by default)
- Builder mode: `cursor` (headless agent, enforced)
- Loop contract: finite ticks only, explicit verdicts, deterministic stop behavior

## Workflow

1. Establish state from `relais/STATE.json` and current git status.
2. Plan a bounded task with explicit scope and acceptance checks.
3. Dispatch BUILD with the selected builder mode.
4. Judge from repo truth (git diff + verify commands), not builder claims.
5. Persist report + next state and stop or continue based on verdict.

## Guardrails (non-negotiable)

- Keep strict contract ownership between orchestrator and builder.
- Enforce write scope and forbidden path checks every tick.
- Treat verification failures and unsafe diffs as hard stops.
- Keep loop finite and restart-safe via persisted state.

## Files this skill expects

- `BOOT.txt`
- `ORCHESTRATOR.md`
- `claude.md`
- `relais/STATE.json`
- `relais/TASK.json`
- `relais/REPORT.json`

## References

- `references/how-it-works.md`
- `references/configuration.md`
- `references/troubleshooting.md`
