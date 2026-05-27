#!/usr/bin/env bash
# check-sdk.sh — print the currently-installed @kynesyslabs/demosdk
# version alongside what package.json declares, so operators can
# verify at a glance whether their tree matches expectations.
#
# Surfaces three things:
#   1. dependencies pin in package.json
#   2. overrides pin in package.json (single-version guarantee)
#   3. actual version installed under node_modules/@kynesyslabs/demosdk
#      AND any nested copies (which would indicate the override didn't
#      take — should never happen on a clean install but useful to
#      catch lockfile drift early).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PKG="@kynesyslabs/demosdk"
cd "${REPO_ROOT}"

DEP="$(bun pm pkg get "dependencies.${PKG}" 2>/dev/null | tr -d '"' || echo "(not declared)")"
OVR="$(bun pm pkg get "overrides.${PKG}" 2>/dev/null | tr -d '"' || echo "(not declared)")"

echo "package.json:"
echo "  dependencies.${PKG} = ${DEP}"
echo "  overrides.${PKG}    = ${OVR}"
echo

INSTALLED_COUNT=0
echo "installed copies under node_modules/:"
# Walk every package.json under any node_modules tree and pull versions
# of @kynesyslabs/demosdk. Multiple lines = the override pin failed and
# bun materialised more than one version.
while IFS= read -r pjson; do
    if grep -q "\"name\": *\"${PKG}\"" "${pjson}"; then
        v="$(grep -oE '"version" *: *"[^"]+"' "${pjson}" | head -1 | sed 's/.*"\([^"]*\)"/\1/')"
        echo "  ${pjson} → ${v}"
        INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
    fi
done < <(find node_modules -path '*/@kynesyslabs/demosdk/package.json' 2>/dev/null)

if [[ "${INSTALLED_COUNT}" -eq 0 ]]; then
    echo "  (none installed — run \`bun install\`)"
elif [[ "${INSTALLED_COUNT}" -gt 1 ]]; then
    echo
    echo "WARN: ${INSTALLED_COUNT} copies of ${PKG} installed."
    echo "      The overrides pin should collapse them to one — run"
    echo "      \`bun run upgrade_sdk\` or check overrides in package.json."
fi
