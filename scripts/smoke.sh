#!/usr/bin/env bash
set -euo pipefail

PREFIX="CLAUDE_RELAIS_SMOKE"
SKILL_NAME="claude-relais"
DEST_BASE=""
RUN_PREFLIGHT=1

usage() {
  cat <<'EOF'
Usage: ./scripts/smoke.sh [options]

Options:
  --dest <path>              Skills base directory
  --no-preflight             Skip CLI/auth checks
  -h, --help                 Show help
EOF
}

resolve_default_dest() {
  if [[ -n "${CLAUDE_RELAIS_DEST:-}" ]]; then
    printf '%s' "${CLAUDE_RELAIS_DEST}"
    return
  fi
  if [[ -d "${HOME}/.claude/skills" ]]; then
    printf '%s' "${HOME}/.claude/skills"
    return
  fi
  if [[ -d "${HOME}/.config/claude/skills" ]]; then
    printf '%s' "${HOME}/.config/claude/skills"
    return
  fi
  printf '%s' "${HOME}/.claude/skills"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST_BASE="${2:-}"
      shift 2
      ;;
    --no-preflight)
      RUN_PREFLIGHT=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$DEST_BASE" ]]; then
  DEST_BASE="$(resolve_default_dest)"
fi

INSTALL_DIR="${DEST_BASE}/${SKILL_NAME}"
REQUIRED=(
  "SKILL.md"
  "BOOT.txt"
  "ORCHESTRATOR.md"
  "claude.md"
  "agents/openai.yaml"
  "references/how-it-works.md"
  "references/configuration.md"
  "references/troubleshooting.md"
  "config.local.json"
)

if [[ ! -d "${INSTALL_DIR}" ]]; then
  echo "${PREFIX}:FAIL:install_missing:${INSTALL_DIR} not found."
  exit 1
fi

for file in "${REQUIRED[@]}"; do
  if [[ ! -f "${INSTALL_DIR}/${file}" ]]; then
    echo "${PREFIX}:FAIL:file_missing:${file}"
    exit 1
  fi
done

if command -v jq >/dev/null 2>&1; then
  if ! jq -e '.orchestrator_model and .builder_mode' "${INSTALL_DIR}/config.local.json" >/dev/null; then
    echo "${PREFIX}:FAIL:config_invalid:config.local.json missing required keys."
    exit 1
  fi
fi

if ! rg -q "^RELAIS v6" "${INSTALL_DIR}/BOOT.txt"; then
  echo "${PREFIX}:FAIL:protocol_mismatch:BOOT.txt is not RELAIS v6."
  exit 1
fi

if ! rg -q "builder\\.mode" "${INSTALL_DIR}/ORCHESTRATOR.md" || \
   ! rg -q "cursor" "${INSTALL_DIR}/ORCHESTRATOR.md" || \
   ! rg -q "Task/sub-agent" "${INSTALL_DIR}/ORCHESTRATOR.md"; then
  echo "${PREFIX}:FAIL:protocol_mismatch:ORCHESTRATOR.md missing cursor-only guardrail."
  exit 1
fi

LEGACY_COMMAND_FILE="${HOME}/.claude/commands/claude-relais.md"
if [[ -f "${LEGACY_COMMAND_FILE}" ]]; then
  echo "${PREFIX}:FAIL:duplicate_entrypoint:legacy command file exists at ${LEGACY_COMMAND_FILE}"
  echo "${PREFIX}:FAIL:remediation:rm ${LEGACY_COMMAND_FILE}"
  exit 1
fi

if [[ "$RUN_PREFLIGHT" -eq 1 ]]; then
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/preflight.sh"
  echo "${PREFIX}:PASS:summary:Skill install and preflight checks passed."
else
  echo "${PREFIX}:PASS:summary:Skill install checks passed (preflight skipped)."
fi
