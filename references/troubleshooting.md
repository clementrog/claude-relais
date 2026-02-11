# Troubleshooting

## `claude` command missing
Install Claude Code CLI and ensure it is in `PATH`.

## Claude auth fails
Run Claude login/auth flow, then rerun:

```bash
./scripts/preflight.sh
```

## Cursor warnings
Cursor is optional. Continue with `claude_code` builder mode or run:

```bash
cursor agent login
cursor agent whoami
```

## Skill not detected
1. Verify installed path with `./scripts/smoke.sh`
2. Ensure `<skills-dir>/claude-relais/SKILL.md` exists
3. Restart Claude Code

## Reinitialize contracts in a target repo

```bash
/path/to/claude-relais/scripts/bootstrap-project.sh --project-root . --force
```
