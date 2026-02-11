# Contract Files

## `relais/STATE.json`
Orchestrator-owned runtime state:
- current phase
- branch/milestone info
- attempt count
- blockers and next step

## `relais/TASK.json`
Orchestrator-owned dispatch contract:
- goal
- scope
- acceptance
- verify commands
- risk

## `relais/REPORT.json`
Builder-owned completion claim:
- status
- changed files
- verify output
- blockers

## `relais/ROADMAP.json`
Optional orchestrator plan for multi-milestone work.

## `relais/REVIEW.json`
Optional escalation contract for deep review.

## `relais/DESIGN-CONTRACT.json`
Optional visual/design constraints and references.
