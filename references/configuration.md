# Configuration

`claude-relais` installs with sensible defaults and explicit overrides.

## Defaults

- Orchestrator model: `opus-4.6`
- Builder mode: `cursor` (enforced)
- Destructive gates: on (`deny_prefixes` + `require_explicit_for_destructive: true`)
- Preflight symlink guard: blocks tracked symlinks that escape repo root
- Install location: first existing match of:
  1. `$CLAUDE_RELAIS_DEST`
  2. `~/.claude/skills`
  3. `~/.config/claude/skills`
  4. fallback: `~/.claude/skills`

## Installer flags

- `--dest <path>`: explicit skills directory
- `--force`: overwrite existing install
- `--model <model_id>`: set orchestrator model in generated config
- `--builder <cursor>`: builder mode (cursor only)
- `--no-preflight`: skip CLI/auth checks
- `--dry-run`: show intended actions only

## Environment overrides

- `CLAUDE_RELAIS_DEST`
- `CLAUDE_RELAIS_ORCHESTRATOR_MODEL`
- `CLAUDE_RELAIS_BUILDER_MODE` (must be `cursor`)

## Installed config

Installer writes `config.local.json` in the installed skill directory:

```json
{
  "orchestrator_model": "opus-4.6",
  "builder_mode": "cursor"
}
```

## Permission mode guidance

- Avoid auto-enabling global `--dangerously-skip-permissions` on skill load.
- Prefer `envoi autonomy --set fast` for low-friction execution with explicit destructive gates.
