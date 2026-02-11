#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_DIR="${REPO_ROOT}/templates/relais"
PROJECT_ROOT="$(pwd)"
FORCE=0
DRY_RUN=0

usage() {
  cat <<'HELP'
Usage: ./scripts/bootstrap-project.sh [options]

Options:
  --project-root <path>      Target project root (default: current directory)
  --force                    Overwrite existing relais files
  --dry-run                  Print actions without writing files
  -h, --help                 Show help
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root)
      PROJECT_ROOT="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=1
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

if [[ ! -d "${PROJECT_ROOT}" ]]; then
  echo "Project root does not exist: ${PROJECT_ROOT}" >&2
  exit 1
fi
if [[ ! -d "${TEMPLATE_DIR}" ]]; then
  echo "Template directory missing: ${TEMPLATE_DIR}" >&2
  exit 1
fi

TARGET_DIR="${PROJECT_ROOT}/relais"
CREATED=0
OVERWRITTEN=0
SKIPPED=0

while IFS= read -r -d '' src; do
  rel="${src#${TEMPLATE_DIR}/}"
  dest="${TARGET_DIR}/${rel}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ -e "$dest" && "$FORCE" -ne 1 ]]; then
      echo "SKIP  ${dest} (exists)"
    elif [[ -e "$dest" ]]; then
      echo "WRITE ${dest} (overwrite)"
    else
      echo "WRITE ${dest}"
    fi
    continue
  fi

  mkdir -p "$(dirname "$dest")"
  if [[ -e "$dest" && "$FORCE" -ne 1 ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if [[ -e "$dest" ]]; then
    OVERWRITTEN=$((OVERWRITTEN + 1))
  else
    CREATED=$((CREATED + 1))
  fi
  cp "$src" "$dest"
done < <(find "${TEMPLATE_DIR}" -type f -print0)

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete."
  exit 0
fi

echo "Bootstrapped relais contracts into ${TARGET_DIR}"
echo "  created:    ${CREATED}"
echo "  overwritten:${OVERWRITTEN}"
echo "  skipped:    ${SKIPPED}"
echo "Next: open Claude Code in ${PROJECT_ROOT} and start from relais/STATE.json"
