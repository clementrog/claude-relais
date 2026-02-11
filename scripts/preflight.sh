#!/usr/bin/env bash
set -euo pipefail

PREFIX="CLAUDE_RELAIS_PRECHECK"
HARD_FAIL=0

emit() {
  local level="$1"
  local code="$2"
  local message="$3"
  printf '%s:%s:%s:%s\n' "$PREFIX" "$level" "$code" "$message"
}

run_with_timeout() {
  local seconds="$1"
  shift
  python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

timeout = float(sys.argv[1])
cmd = sys.argv[2:]

try:
    completed = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )
    raise SystemExit(completed.returncode)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
PY
}

check_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    emit "FAIL" "claude_cli_missing" "Install Claude Code CLI and ensure 'claude' is in PATH."
    HARD_FAIL=1
    return
  fi

  if run_with_timeout 8 claude whoami || run_with_timeout 8 claude auth status; then
    emit "PASS" "claude_auth" "Claude CLI is installed and authenticated."
  else
    emit "FAIL" "claude_auth" "Claude CLI found but auth check failed."
    HARD_FAIL=1
  fi
}

check_cursor_optional() {
  if ! command -v cursor >/dev/null 2>&1; then
    emit "WARN" "cursor_cli_missing" "Cursor CLI not found. Continuing with claude_code builder mode."
    return
  fi

  if run_with_timeout 8 cursor agent whoami; then
    emit "PASS" "cursor_auth" "Cursor Agent is available and authenticated."
  else
    emit "WARN" "cursor_auth" "Cursor CLI found but agent auth check failed."
  fi
}

check_claude
check_cursor_optional

if [[ "$HARD_FAIL" -ne 0 ]]; then
  emit "FAIL" "summary" "Preflight failed."
  exit 1
fi

emit "PASS" "summary" "Preflight passed."
