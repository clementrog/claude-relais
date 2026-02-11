# Claude Code Profile: claude-relais

## Role detection

- `phase: BUILD` in `relais/STATE.json` => Builder mode
- Any other phase => Orchestrator mode

## Core behavior

- Respect contract ownership.
- Keep scope strict and explicit.
- Prefer deterministic outputs and finite cycles.

## Builder checklist

1. Read `relais/TASK.json`
2. Modify only allowed paths
3. Run verify commands
4. Write `relais/REPORT.json` with evidence

## Orchestrator checklist

1. Read `relais/STATE.json`
2. Plan/dispatch bounded work
3. Judge using git truth + verification
4. Update `relais/STATE.json`
