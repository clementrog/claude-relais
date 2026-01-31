Relais

Relais is a CLI runner focused on reliable artifact persistence and safe interrupt handling (SIGINT / Ctrl+C).

Build
cd /Users/clement/projects/relais
npm run build

Run (local)
node /Users/clement/projects/relais/dist/index.js run


Workspace directory is configured via relais.config.json (default: relais/).

SIGINT / interrupt behavior (manual verification)

Run this from the dogfood repo:

cd /Users/clement/projects/relais-dogfood

# clean workspace artifacts for deterministic verification
rm -f relais/lock.json relais/REPORT.json relais/REPORT.md relais/BLOCKED.json

# start Relais (built from /Users/clement/projects/relais)
node /Users/clement/projects/relais/dist/index.js run &
PID=$!

# let orchestration start
sleep 2

# send SIGINT
kill -INT "$PID"

# wait and capture exit code
wait "$PID"
echo "exit_code=$?"

# verify artifacts + lock release
ls -la relais/REPORT.json relais/REPORT.md
ls relais/lock.json 2>/dev/null && echo "FAIL: lock not released" || echo "OK: lock released"


Expected:

Logs include: [INTERRUPT] Abort signal received; persisting STOP_INTERRUPTED report

Exit code is 130

relais/REPORT.json exists (and relais/REPORT.md if enabled)

relais/lock.json is gone

Repo notes

relais/ contains workspace templates (prompts, schemas, fixtures) and runtime artifacts (ignored).

pilot/ is documentation for older workflows.
