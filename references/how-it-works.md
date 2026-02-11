# How claude-relais Works

`claude-relais` enforces a contract-driven loop for AI delivery:

1. PLAN
2. BUILD
3. JUDGE
4. REPORT

## Key invariants

- The orchestrator controls scope and acceptance.
- The builder executes only within scoped boundaries.
- Judge relies on git and verification output, not model assertions.
- Each tick is finite and restart-safe.
