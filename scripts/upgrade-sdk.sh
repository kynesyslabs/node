#!/usr/bin/env bash
# upgrade-sdk.sh — upgrade @kynesyslabs/demosdk to latest, then pin the
# resolved version in BOTH `dependencies` and `overrides` so the next
# `bun install` (and every CI build) gets the exact same version back.
#
# Why pin both:
#   - `dependencies` controls what THIS package requests.
#   - `overrides` flattens the install tree so no transitive dep
#     (including the self-dep loop the SDK shipped pre-4.0.1) can
#     sneak a different version in alongside ours.
#
# Why not leave `overrides` at `"latest"`:
#   "latest" is non-deterministic — two operators running `bun install`
#   an hour apart could end up on different SDK versions while the
#   lockfile silently absorbs the drift. Pinning the exact version makes
#   the build bit-reproducible; upgrading becomes an explicit
#   `bun run upgrade_sdk` operator action.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PKG="@kynesyslabs/demosdk"
cd "${REPO_ROOT}"

echo "[upgrade-sdk] upgrading ${PKG} to latest…"
bun update "${PKG}" --latest

# Read whatever resolved range bun wrote into package.json and strip
# the `^` / `~` prefix. bun pm pkg get returns a JSON-encoded string,
# so trim the surrounding quotes too.
RESOLVED="$(bun pm pkg get "dependencies.${PKG}" | tr -d '"')"
EXACT="${RESOLVED#[\^~]}"

if [[ ! "${EXACT}" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    echo "[upgrade-sdk] dependency range '${RESOLVED}' is not a plain version; refusing to pin a non-semver value." >&2
    exit 1
fi

echo "[upgrade-sdk] pinning ${PKG}=${EXACT} in dependencies + overrides…"
bun pm pkg set "dependencies.${PKG}=${EXACT}"
bun pm pkg set "overrides.${PKG}=${EXACT}"

echo "[upgrade-sdk] re-installing so the lockfile reflects the override…"
bun install

echo "[upgrade-sdk] done — ${PKG} pinned at ${EXACT}."
