#!/usr/bin/env bash
# wipe-and-reboot.sh — full reset of a Demos node host so freshly-merged
# fixes (genesis overlay, validation, schema migrations) actually take
# effect on the next boot.
#
# The chain's `restoreSnapshot.preflightEmpty` refuses to run against a
# non-empty DB, so partial wipes will fail to boot. Forgetting to wipe
# is the single most common reason "we merged the fix but the symptom
# still reproduces" — this script makes the wipe deterministic so the
# next boot starts from a verified-clean state.
#
# What it does, in order:
#   1. Sanity-check the working tree is on a branch + clean (operator
#      pushed everything they meant to push).
#   2. Stops the stack via `./scripts/docker-run down`.
#   3. Removes all three named volumes (PG data, node data, node state).
#   4. Forces a `--no-cache` rebuild of the node image (so source
#      changes since the last build are picked up).
#   5. Boots the stack detached.
#   6. Tails the GENESIS / FORK / BALANCES log lines so the operator
#      can confirm the chain came up clean.
#
# Safe to Ctrl-C at any step. Steps 1–2 are non-destructive. Step 3 is
# destructive (wipes the chain DB) — that's the whole point. Steps 4+
# are idempotent.
#
# Usage:
#   ./scripts/wipe-and-reboot.sh             # interactive confirm before wipe
#   ./scripts/wipe-and-reboot.sh --yes       # skip the confirmation
#   ./scripts/wipe-and-reboot.sh --no-rebuild  # skip the --no-cache image rebuild

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

YES=0
DO_REBUILD=1
for arg in "$@"; do
    case "$arg" in
        --yes|-y) YES=1 ;;
        --no-rebuild) DO_REBUILD=0 ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *)
            echo "unknown flag: $arg"
            exit 2
            ;;
    esac
done

# -----------------------------------------------------------------------------
# 1. Sanity-check the working tree
# -----------------------------------------------------------------------------
echo "[1/6] working-tree sanity check..."
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [[ -z "$CURRENT_BRANCH" ]]; then
    echo "  WARN: not on a git branch (detached HEAD?). Continuing anyway."
else
    echo "  branch: $CURRENT_BRANCH"
fi
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo "  WARN: working tree has uncommitted changes — the rebuild will"
    echo "        bake those into the image. Press Ctrl-C if not intended."
    git status --short | head -10 | sed 's/^/    /'
fi

# -----------------------------------------------------------------------------
# 2. Confirm wipe
# -----------------------------------------------------------------------------
if [[ "$YES" -ne 1 ]]; then
    echo
    echo "[!] About to WIPE all chain data volumes (demos_pgdata,"
    echo "    demos_node_data, demos_node_state). This is destructive."
    read -r -p "    Type 'wipe' to confirm: " confirm
    if [[ "$confirm" != "wipe" ]]; then
        echo "    aborted."
        exit 1
    fi
fi

# -----------------------------------------------------------------------------
# 3. Stop the stack
# -----------------------------------------------------------------------------
echo "[2/6] stopping docker stack..."
if [[ -x ./scripts/docker-run ]]; then
    ./scripts/docker-run down >/dev/null 2>&1 || true
else
    docker compose down >/dev/null 2>&1 || true
fi

# -----------------------------------------------------------------------------
# 4. Wipe volumes
# -----------------------------------------------------------------------------
echo "[3/6] removing data volumes (demos_pgdata, demos_node_data, demos_node_state)..."
docker volume rm demos_pgdata demos_node_data demos_node_state 2>/dev/null || true

remaining="$(docker volume ls --format '{{.Name}}' | grep -E '^demos_' || true)"
if [[ -n "$remaining" ]]; then
    echo "  WARN: leftover demos_* volumes still present (may shadow the wipe):"
    echo "$remaining" | sed 's/^/    /'
fi

# -----------------------------------------------------------------------------
# 5. Rebuild image
# -----------------------------------------------------------------------------
if [[ "$DO_REBUILD" -eq 1 ]]; then
    echo "[4/6] rebuilding node image (--no-cache)..."
    if [[ -x ./scripts/docker-run ]]; then
        ./scripts/docker-run --rebuild build
    else
        docker compose build --no-cache node
    fi
else
    echo "[4/6] skipping image rebuild (--no-rebuild)."
fi

# -----------------------------------------------------------------------------
# 6. Boot
# -----------------------------------------------------------------------------
echo "[5/6] booting stack..."
if [[ -x ./scripts/docker-run ]]; then
    ./scripts/docker-run up -d
else
    docker compose up -d
fi

# -----------------------------------------------------------------------------
# 7. Tail genesis log lines
# -----------------------------------------------------------------------------
echo "[6/6] tailing GENESIS / FORK / BALANCES log lines (Ctrl-C to stop)."
echo "      Expect to see:"
echo "        [GENESIS][BALANCES] overlaying N entries from genesisData.balances"
echo "        [GENESIS][BALANCES] overlay done — total=N updated=X inserted=Y"
echo "        [FORKS] Loaded fork \"osDenomination\" with activationHeight=0"
echo
docker compose logs -f node 2>&1 | grep --line-buffered -E "GENESIS|BALANCES|FORK"
