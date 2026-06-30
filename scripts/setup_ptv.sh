#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PTV_DIR="${ROOT_DIR}/external/PTV"
PTV_REPO="${PTV_REPO:-https://github.com/aaronxyliu/PTV.git}"

mkdir -p "${ROOT_DIR}/external"

if [ -d "${PTV_DIR}/.git" ]; then
  echo "PTV already exists at ${PTV_DIR}; updating it."
  git -C "${PTV_DIR}" pull --ff-only
elif [ -e "${PTV_DIR}" ]; then
  echo "Refusing to overwrite non-git path: ${PTV_DIR}" >&2
  exit 1
else
  echo "Cloning PTV from ${PTV_REPO} into ${PTV_DIR}."
  git clone "${PTV_REPO}" "${PTV_DIR}"
fi

if [ ! -f "${PTV_DIR}/manifest.json" ]; then
  echo "PTV setup failed: manifest.json not found in ${PTV_DIR}" >&2
  exit 1
fi

echo "PTV setup complete: ${PTV_DIR}"
