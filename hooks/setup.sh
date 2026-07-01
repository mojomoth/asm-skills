#!/usr/bin/env bash
# hooks/setup.sh — idempotent dependency bootstrap for the asm-mentor plugin.
#
# Runs on every SessionStart. Installs playwright + node-html-parser into
# CLAUDE_PLUGIN_DATA (a per-user dir that survives plugin updates), then
# symlinks skills/asm-mentor-core/node_modules -> that install.
#
# Why a symlink and not NODE_PATH: scripts/asm.mjs and scripts/lib/*.mjs are
# ES modules ("type":"module" in package.json). Node's ESM resolver does NOT
# consult NODE_PATH (that only affects CommonJS require()) — it walks up
# parent directories from the *importing file's own path* looking for
# node_modules, exactly like CommonJS. A symlink placed as a sibling of
# package.json satisfies that walk with zero code changes.
#
# Never blocks SessionStart: every risky step degrades to a stderr warning
# and the script always exits 0.

CORE_DIR="${CLAUDE_PLUGIN_ROOT}/skills/asm-mentor-core"
DATA_DIR="${CLAUDE_PLUGIN_DATA}"
SRC_PKG="${CORE_DIR}/package.json"
LINK="${CORE_DIR}/node_modules"

mkdir -p "${DATA_DIR}" 2>/dev/null

if [ ! -f "${SRC_PKG}" ]; then
  echo "asm-mentor: ${SRC_PKG} not found, skipping dependency setup" >&2
  exit 0
fi

if ! diff -q "${SRC_PKG}" "${DATA_DIR}/package.json" >/dev/null 2>&1; then
  cp "${SRC_PKG}" "${DATA_DIR}/package.json"
  cp "${CORE_DIR}/package-lock.json" "${DATA_DIR}/package-lock.json" 2>/dev/null

  (
    cd "${DATA_DIR}" || exit 1
    if [ -f package-lock.json ]; then
      npm ci --omit=dev --no-audit --no-fund
    else
      npm install --omit=dev --no-audit --no-fund
    fi
  )
  if [ $? -ne 0 ]; then
    echo "asm-mentor: npm install failed, will retry next session" >&2
    rm -f "${DATA_DIR}/package.json"
  fi
fi

if [ -d "${DATA_DIR}/node_modules" ]; then
  if [ -e "${LINK}" ] && [ ! -L "${LINK}" ]; then
    rm -rf "${LINK}"   # replace a stray real dir (e.g. leftover manual `npm install`)
  fi
  ln -sfn "${DATA_DIR}/node_modules" "${LINK}"
fi

if [ -x "${DATA_DIR}/node_modules/.bin/playwright" ]; then
  "${DATA_DIR}/node_modules/.bin/playwright" install chromium \
    || echo "asm-mentor: playwright chromium install failed (will retry next session)" >&2
fi

exit 0
