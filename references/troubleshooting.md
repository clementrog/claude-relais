# Troubleshooting

## `claude` command not found

Install Claude Code CLI and ensure `claude` is available in `PATH`.

## Claude auth check fails

Run your Claude login flow, then rerun:

```bash
./scripts/preflight.sh
```

## Cursor warnings during preflight

Cursor agent is required for build execution. Fix Cursor auth:

```bash
cursor agent login
cursor agent whoami
```

## Skill appears installed but is not picked up

1. Confirm location with:
```bash
./scripts/smoke.sh
```
2. Verify `SKILL.md` exists under `<skills-dir>/claude-relais/`.
3. Restart Claude Code session so it reloads installed skills.

## Reinstall cleanly

```bash
./scripts/uninstall.sh --yes
./scripts/install.sh --force
```
