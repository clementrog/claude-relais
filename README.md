# claude-relais

`claude-relais` is a Claude Code orchestration skill built on a simple split:

- **Think (Claude):** high-reasoning orchestration and task design (default: Opus `opus-4.6`)
- **Build (Cursor):** fast implementation with Cursor headless agents
- **Judge (Guardrails):** strict `PLAN -> BUILD -> JUDGE` contracts with stop/block safety checks

Heavy reasoning models are excellent for planning, but slower and more limit-intensive for direct implementation. `claude-relais` keeps Claude focused on thinking and uses Cursor for execution throughput.

For many users, this split delivers high sustained output at roughly the cost of two standard plans (around ~$40/month combined), depending on provider pricing, plan limits, and usage patterns.

## How it works

1. **ROUTER**: Claude routes input:
- explicit `envoi ...` commands are executed directly; otherwise it checks `relais/` state.
2. **ONBOARD OR CONTINUE**:
- fresh repo or missing roadmap -> guided onboarding (mode + PRD + roadmap); existing state -> next-step options.
3. **PLAN**: orchestrator defines one bounded task and scope.
4. **BUILD**: task is dispatched to Cursor headless agent (mandatory).
5. **VERIFY/UPDATE**: Claude verifies against git truth, updates roadmap/state, and loops.

Mode stop conditions:
- `task`: stop after one successful task
- `milestone`: stop when active milestone is done
- `autonomous`: continue until blocked/limit/signal

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
- destructive command gates on by default:
`deny_prefixes` includes `rm`, `sudo`, `git reset --hard`, `git checkout --`, `git clean -fd`, `git clean -fdx`, `mkfs`, `dd`
- `require_explicit_for_destructive: true`
- preflight blocks tracked symlinks that resolve outside repo root

Permission note:
- do not auto-enable global `--dangerously-skip-permissions` at skill load
- use `envoi autonomy --set fast` for low-friction mode with guardrails

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
- Duplicate `/claude-relais` entries or odd behavior:
```bash
rm ~/.claude/commands/claude-relais.md
```
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
