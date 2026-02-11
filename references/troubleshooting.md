# Troubleshooting

## Claude plans/displays contracts but does not actually run `envoi ...`

Cause: command text is being interpreted as orchestration prose instead of CLI passthrough.

Fix:
- Enter explicit commands starting with `envoi `.
- Ensure skill is updated to router-first protocol (see smoke checks).

## BUILD appears to run in Claude (not Cursor)

Cause: legacy protocol behavior or missing cursor dispatch evidence.

Fix:
1. Verify `relais/TASK.json` has `builder.mode = "cursor"`.
2. Verify `relais/REPORT.json` includes cursor dispatch command/exit code/log paths.
3. Run cursor auth checks:
```bash
cursor agent --help
cursor agent whoami
```

## No onboarding in fresh repo

Expected: fresh repos or missing `relais/ROADMAP.json` should route to onboarding.

If not:
1. Run smoke checks to verify installed protocol version.
2. Reinstall skill with force:
```bash
./scripts/uninstall.sh --yes
./scripts/install.sh --force
```
3. Restart Claude Code session.

## Duplicate `/claude-relais` entries

Cause: both installed skill and legacy user command file exist.

Fix:
```bash
rm ~/.claude/commands/claude-relais.md
```
Then restart Claude Code.

## Skill appears installed but behavior is old

Run:
```bash
./scripts/smoke.sh
```
Ensure it reports protocol marker `RELAIS v6` from installed `BOOT.txt`.
