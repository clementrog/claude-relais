# Contract Files

## `pilot/STATE.json`
Orchestrator-owned runtime state:
- current phase
- branch/milestone info
- attempt count
- blockers and next step

## `pilot/TASK.json`
Orchestrator-owned dispatch contract:
- goal
- scope
- acceptance
- verify commands
- risk

## `pilot/REPORT.json`
Builder-owned completion claim:
- status
- changed files
- verify output
- blockers

## `pilot/ROADMAP.json`
Optional orchestrator plan for multi-milestone work.

## `pilot/REVIEW.json`
Optional escalation contract for deep review.

## `pilot/DESIGN-CONTRACT.json`
Optional visual/design constraints and references.
