#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="claude-relais"
DEST_BASE=""
YES=0

usage() {
  cat <<'HELP'
Usage: ./scripts/uninstall.sh [options]

Options:
  --dest <path>              Skills base directory
  --yes                      Skip confirmation prompt
  -h, --help                 Show help
HELP
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
    --yes)
      YES=1
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

if [[ ! -e "${INSTALL_DIR}" ]]; then
  echo "Nothing to uninstall. Path not found: ${INSTALL_DIR}"
  exit 0
fi

if [[ "$YES" -ne 1 ]]; then
  read -r -p "Remove ${INSTALL_DIR}? [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Canceled."; exit 1 ;;
  esac
fi

rm -rf "${INSTALL_DIR}"
echo "Removed ${INSTALL_DIR}"
