# How claude-relais Works

`claude-relais` is an orchestration skill for Claude Code that separates planning, building, and judging into explicit contracts.

## Core loop

1. **PLAN**: Orchestrator defines one bounded task and scope.
2. **BUILD**: Builder executes implementation inside allowed paths.
3. **JUDGE**: Orchestrator verifies using git truth + verify commands.

Each cycle is finite and produces a report with a deterministic verdict (`success`, `stop`, or `blocked`).

## Why it is fast and safe

- **Fast**: Cursor headless builder can execute broad edits quickly.
- **Safe**: Scope, diff, and verification checks gate progress before merge.
- **Stable**: State and reports are persisted under `relais/` so sessions can resume cleanly.

## Contract ownership

- Orchestrator owns planning/control contracts (`STATE`, `TASK`, roadmap/review contracts).
- Builder owns code changes and `REPORT`.
- Crossing those boundaries is treated as a protocol violation.
