# claude-relais

[![CI](https://github.com/clementrog/claude-relais/actions/workflows/ci.yml/badge.svg)](https://github.com/clementrog/claude-relais/actions/workflows/ci.yml)

`claude-relais` is an orchestration skill for Claude Code that combines:

- high-reasoning planning (default orchestrator: `opus-4.6`)
- fast build execution (Cursor headless builders when available)
- strict guardrails (PLAN -> BUILD -> JUDGE with explicit contracts)

It is built for teams who want speed without losing deterministic control.

## Why this is different

Most agent workflows optimize either speed or safety. `claude-relais` enforces both:

- **Bounded ticks:** each cycle is finite and produces a deterministic verdict.
- **Contract ownership:** orchestrator and builder have strict write boundaries.
- **Git truth first:** judging is based on repo state and verification, not model claims.

## Architecture

1. **PLAN**: define one bounded task and scope in `pilot/TASK.json`.
2. **BUILD**: execute with selected builder mode.
3. **JUDGE**: verify scope, diffs, and checks from git truth.
4. **REPORT**: persist state/report and decide stop/continue.

References:

- `references/how-it-works.md`
- `references/contracts.md`
- `references/configuration.md`

## Requirements

- Claude Code CLI installed and authenticated (`claude whoami`) **required**
- Git **required**
- Bash **required**
- Cursor CLI (`cursor agent whoami`) **optional** for acceleration

## Install Skill (one command)

```bash
git clone https://github.com/clementrog/claude-relais.git && cd claude-relais && ./scripts/install.sh
```

## Bootstrap a target project (one command)

Run this from the repository you want Claude to work on:

```bash
/path/to/claude-relais/scripts/bootstrap-project.sh --project-root .
```

This creates `pilot/` contracts from templates.

## Verify install

```bash
./scripts/smoke.sh
```

Expected summary lines:

- `CLAUDE_RELAIS_PRECHECK:PASS:summary:Preflight passed.`
- `CLAUDE_RELAIS_SMOKE:PASS:summary:Skill install and preflight checks passed.`

## First run prompt in Claude Code

After bootstrapping your target repo, start Claude Code in that target repo and ask:

```text
Use the claude-relais orchestration workflow. Start from pilot/STATE.json, plan one bounded task, dispatch build, then judge with git truth.
```

## Configuration

Defaults:

- orchestrator model: `opus-4.6`
- builder mode: `cursor`

Override at install time:

```bash
./scripts/install.sh --model opus-4.6 --builder claude_code
```

More in `references/configuration.md`.

## Troubleshooting

- Claude auth fails: run login and retry `./scripts/preflight.sh`
- Cursor unavailable: continue with Claude builder mode
- Contracts missing: rerun `bootstrap-project.sh --force`

More in `references/troubleshooting.md`.

## Contributing and Security

- `CONTRIBUTING.md`
- `SECURITY.md`

## License

MIT (`LICENSE`).
