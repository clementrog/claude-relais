# claude-relais

`claude-relais` is a Claude Code orchestration skill built on a simple split:

- **Think (Claude):** high-reasoning orchestration and task design (default: Opus `opus-4.6`)
- **Build (Cursor):** fast implementation with Cursor headless agents
- **Judge (Guardrails):** strict `PLAN -> BUILD -> JUDGE` contracts with stop/block safety checks

Heavy reasoning models are excellent for planning, but slower and more limit-intensive for direct implementation. `claude-relais` keeps Claude focused on thinking and uses Cursor for execution throughput.

For many users, this split delivers high sustained output at roughly the cost of two standard plans (around ~$40/month combined), depending on provider pricing, plan limits, and usage patterns.

## Why this exists

Most agent loops either:

- use one heavy model for everything (good reasoning, slower implementation, higher limit pressure), or
- use faster builders without strong orchestration and safety rails.

`claude-relais` combines both:

- **Speed at implementation time:** Cursor builder handles clear, bounded tasks quickly.
- **High-quality planning:** Claude handles decomposition, sequencing, and boundary setting.
- **Guardrails and determinism:** scope/diff/verify checks gate unsafe changes, and every tick persists state in `relais/`.

## How it works

1. **PLAN**: orchestrator defines one bounded task and scope.
2. **BUILD**: builder executes inside allowed boundaries.
3. **JUDGE**: orchestrator verifies against git truth and verify commands.
4. **REPORT**: state and verdict persist so loops can resume safely.

## Requirements

- Claude Code CLI installed and authenticated (`claude whoami`)
- Git
- Bash
- Cursor CLI installed and authenticated (`cursor agent whoami`)

## Install (one command)

```bash
git clone https://github.com/clementrog/claude-relais.git && cd claude-relais && ./scripts/install.sh
```

What this does:

- installs skill files into your Claude skills directory
- writes `config.local.json` with default model/builder
- runs preflight checks (Claude + Cursor required)
- does not require installing legacy `envoi` npm packages

## Verify installation

```bash
./scripts/smoke.sh
```

You should see:

- `CLAUDE_RELAIS_PRECHECK:PASS:summary:Preflight passed.`
- `CLAUDE_RELAIS_SMOKE:PASS:summary:Skill install and preflight checks passed.`

## First run in Claude Code

1. Restart Claude Code if it was already open.
2. Open your target repo.
3. Ask Claude to run with `claude-relais` orchestration for your task.
4. Keep task scope explicit and bounded per tick.

## Configuration

Defaults:

- orchestrator model: `opus-4.6`
- builder mode: `cursor` (enforced; non-cursor builder tasks are blocked)

Override at install time:

```bash
./scripts/install.sh --model opus-4.6 --builder cursor
```

Custom install location:

```bash
./scripts/install.sh --dest ~/.claude/skills
```

## Troubleshooting

- Missing Claude CLI/auth: run login flow, then `./scripts/preflight.sh`
- Cursor auth warning: run `cursor agent login` then retry preflight
- Skill not picked up: ensure `<skills-dir>/claude-relais/SKILL.md` exists, then restart Claude Code
- Reinstall cleanly:

```bash
./scripts/uninstall.sh --yes
./scripts/install.sh --force
```

## Reference docs

- `SKILL.md`
- `references/how-it-works.md`
- `references/configuration.md`
- `references/troubleshooting.md`
