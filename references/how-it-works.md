# How claude-relais Works

`claude-relais` runs a router-first orchestration loop with strict role separation:

- Claude: route, plan, verify, update roadmap/state
- Cursor: implement code changes during BUILD

## Entry behavior

On each user message:

1. If the message is an explicit CLI command (`envoi ...`), execute it directly.
2. Otherwise route by repo state:
- Fresh/missing roadmap: guided onboarding
- Existing state: next-step options + continuation

## Core loop

`ROUTER -> ONBOARD -> PLAN -> DISPATCH -> BUILD -> VERIFY -> UPDATE`

Then either continue or stop based on mode:
- `task`: stop after one task
- `milestone`: stop at milestone boundary
- `autonomous`: continue until blocked/limit/signal

## Why it is safe

- BUILD is cursor-only (no Claude builder fallback)
- Contracts are explicit (`STATE`, `TASK`, `REPORT`, `ROADMAP`)
- Verification uses git truth and task verify commands
- Scope violations and failed reports increment attempts and can halt

## Required build evidence

`relais/REPORT.json` must show cursor dispatch details and verification evidence before orchestration can continue.
