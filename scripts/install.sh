#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_NAME="claude-relais"

DEST_BASE=""
FORCE=0
DRY_RUN=0
RUN_PREFLIGHT=1
MODEL="${CLAUDE_RELAIS_ORCHESTRATOR_MODEL:-opus-4.6}"
BUILDER="${CLAUDE_RELAIS_BUILDER_MODE:-cursor}"

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [options]

Options:
  --dest <path>              Install base directory (skill will be placed in <path>/claude-relais)
  --force                    Overwrite existing install
  --model <model_id>         Orchestrator model (default: opus-4.6)
  --builder <mode>           Builder mode: cursor (default: cursor)
  --no-preflight             Skip CLI/auth checks
  --dry-run                  Print actions without writing files
  -h, --help                 Show help
EOF
}

resolve_default_dest() {
  local candidate
  if [[ -n "${CLAUDE_RELAIS_DEST:-}" ]]; then
    printf '%s' "${CLAUDE_RELAIS_DEST}"
    return
  fi

  for candidate in "${HOME}/.claude/skills" "${HOME}/.config/claude/skills"; do
    if [[ -d "$candidate" ]]; then
      printf '%s' "$candidate"
      return
    fi
  done

  printf '%s' "${HOME}/.claude/skills"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST_BASE="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --builder)
      BUILDER="${2:-}"
      shift 2
      ;;
    --no-preflight)
      RUN_PREFLIGHT=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
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

if [[ "$BUILDER" != "cursor" ]]; then
  echo "Invalid --builder value: ${BUILDER}. Only 'cursor' is supported." >&2
  exit 1
fi

if [[ -z "$DEST_BASE" ]]; then
  DEST_BASE="$(resolve_default_dest)"
fi

INSTALL_DIR="${DEST_BASE}/${SKILL_NAME}"
SOURCE_ITEMS=(
  "SKILL.md"
  "BOOT.txt"
  "ORCHESTRATOR.md"
  "claude.md"
  "agents"
  "references"
)

for item in "${SOURCE_ITEMS[@]}"; do
  if [[ ! -e "${REPO_ROOT}/${item}" ]]; then
    echo "Missing required source item: ${REPO_ROOT}/${item}" >&2
    exit 1
  fi
done

echo "Installing ${SKILL_NAME}"
echo "  Source: ${REPO_ROOT}"
echo "  Dest:   ${INSTALL_DIR}"
echo "  Model:  ${MODEL}"
echo "  Builder:${BUILDER}"

if [[ "$RUN_PREFLIGHT" -eq 1 ]]; then
  "${SCRIPT_DIR}/preflight.sh"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete. No files were written."
  exit 0
fi

mkdir -p "${DEST_BASE}"

if [[ -e "${INSTALL_DIR}" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "Install path already exists: ${INSTALL_DIR}" >&2
    echo "Re-run with --force to overwrite." >&2
    exit 1
  fi
  rm -rf "${INSTALL_DIR}"
fi

mkdir -p "${INSTALL_DIR}"

for item in "${SOURCE_ITEMS[@]}"; do
  cp -R "${REPO_ROOT}/${item}" "${INSTALL_DIR}/${item}"
done

cat > "${INSTALL_DIR}/config.local.json" <<EOF
{
  "orchestrator_model": "${MODEL}",
  "builder_mode": "${BUILDER}"
}
EOF

BOOT_MARKER="$(head -n 1 "${INSTALL_DIR}/BOOT.txt" 2>/dev/null || true)"
LEGACY_COMMAND_FILE="${HOME}/.claude/commands/claude-relais.md"

echo "Installed skill files to ${INSTALL_DIR}"
echo "Protocol: ${BOOT_MARKER}"
if [[ -f "${LEGACY_COMMAND_FILE}" ]]; then
  echo "WARNING: legacy command file detected at ${LEGACY_COMMAND_FILE}"
  echo "         This can cause duplicate or conflicting /claude-relais behavior."
  echo "         Remove it with: rm ${LEGACY_COMMAND_FILE}"
fi
echo "Next:"
echo "  1) Restart Claude Code (if already running)"
echo "  2) Start a session and invoke the claude-relais skill"
echo "  3) Run ${SCRIPT_DIR}/smoke.sh --dest \"${DEST_BASE}\" to verify install"
