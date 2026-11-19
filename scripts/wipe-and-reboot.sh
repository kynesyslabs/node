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
#   2. Stops the stack via `./scripts/docker-run down` (or `--devnet down`).
#   3. Removes the PG data and node data volumes of the targeted stack
#      (demos_pgdata, demos_node_data; *_devnet with --devnet). The node
#      state volume (demos_node_state: identity, peer list and the validator
#      signing record and commit lock that stop the key from signing a
#      height twice) is kept unless --wipe-signing-state is given. The logs,
#      Prometheus and Grafana volumes are kept.
#   4. Forces a `--no-cache` rebuild of the node image (so source
#      changes since the last build are picked up), then prunes build
#      cache older than 24h.
#   5. Boots the stack detached.
#   6. Tails the GENESIS / FORK / BALANCES log lines so the operator
#      can confirm the chain came up clean.
#
# Safe to Ctrl-C at any step. Steps 1–2 are non-destructive. Step 3 is
# destructive (wipes the chain DB) — that's the whole point. Steps 4+
# are idempotent.
#
# Usage:
#   ./scripts/wipe-and-reboot.sh                # mainnet/testnet stack, interactive
#   ./scripts/wipe-and-reboot.sh --yes          # skip confirmation
#   ./scripts/wipe-and-reboot.sh --no-rebuild   # skip --no-cache rebuild
#   ./scripts/wipe-and-reboot.sh --devnet       # devnet stack (demos-devnet project,
#                                               # demos_*_devnet volumes, +100 ports)
#   ./scripts/wipe-and-reboot.sh --wipe-signing-state
#                                               # also delete the node state volume,
#                                               # signing record included: only when
#                                               # the chain itself is being reset
#
# Flags compose: `--devnet --yes --no-rebuild` is valid.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

YES=0
DO_REBUILD=1
IS_DEVNET=0
WIPE_SIGNING=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y) YES=1 ;;
        --no-rebuild) DO_REBUILD=0 ;;
        --devnet) IS_DEVNET=1 ;;
        --wipe-signing-state) WIPE_SIGNING=1 ;;
        -h|--help)
            sed -n '2,44p' "$0"
            exit 0
            ;;
        *)
            echo "unknown flag: $arg"
            exit 2
            ;;
    esac
done

# Stack-specific names. The devnet override uses a different compose
# project (demos-devnet) and namespaced volumes (demos_*_devnet); the
# script must wipe whichever set matches the targeted stack.
if [[ "$IS_DEVNET" -eq 1 ]]; then
    STACK_LABEL="devnet"
    DOCKER_RUN_ARGS=(--devnet)
    VOLUMES=(demos_pgdata_devnet demos_node_data_devnet)
    STATE_VOLUME=demos_node_state_devnet
    VOLUME_RE='^demos_.*_devnet$'
    COMPOSE_PROJECT=demos-devnet
else
    STACK_LABEL="mainnet/testnet"
    DOCKER_RUN_ARGS=()
    VOLUMES=(demos_pgdata demos_node_data)
    STATE_VOLUME=demos_node_state
    # Match `demos_*` but explicitly exclude the devnet siblings so we
    # don't mistake an idle devnet stack for stale mainnet volumes.
    VOLUME_RE='^demos_[^_]+(_[^_]+)?$'
    COMPOSE_PROJECT=""
fi

# The state volume holds the signing record and commit lock. A database wipe of
# the same chain must keep them: the node resyncs and would otherwise sign
# again at heights it already signed.
if [[ "$WIPE_SIGNING" -eq 1 ]]; then
    VOLUMES+=("$STATE_VOLUME")
    echo
    echo "  !!! --wipe-signing-state: ${STATE_VOLUME} is DELETED, with the node identity,"
    echo "  !!! the validator signing record and the commit lock. Those two are what stops"
    echo "  !!! this key from signing a height twice. Use it only when the chain itself is"
    echo "  !!! reset; on a live network it can get the validator slashed."
    echo
else
    echo "  keeping ${STATE_VOLUME} (identity, signing record, commit lock);"
    echo "  pass --wipe-signing-state only when the chain itself is reset."
fi

# -----------------------------------------------------------------------------
# 1. Sanity-check the working tree
# -----------------------------------------------------------------------------
echo "[1/6] working-tree sanity check (target: ${STACK_LABEL})..."
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
# Stop, rebuild and boot all go through scripts/docker-run: only it creates the
# schema on the wiped database, and a raw `docker compose up` would start the
# node with none. Refuse before anything is wiped.
if [[ ! -x ./scripts/docker-run ]]; then
    echo "  ERROR: ./scripts/docker-run is missing or not executable (chmod +x scripts/docker-run); nothing was wiped."
    exit 1
fi

# -----------------------------------------------------------------------------
# 2. Confirm wipe
# -----------------------------------------------------------------------------
if [[ "$YES" -ne 1 ]]; then
    echo
    echo "[!] About to DELETE these Docker volumes of the ${STACK_LABEL} stack:"
    printf '      %s\n' "${VOLUMES[@]}"
    echo "    No other volume is deleted (logs, Prometheus and Grafana are kept)."
    if [[ "$WIPE_SIGNING" -eq 1 ]]; then
        echo "    This is destructive: the chain database and the node state, signing record included, are lost."
    else
        echo "    This is destructive: the chain database is lost. ${STATE_VOLUME} is kept."
    fi
    read -r -p "    Type 'wipe' to confirm: " confirm
    if [[ "$confirm" != "wipe" ]]; then
        echo "    aborted."
        exit 1
    fi
fi

# -----------------------------------------------------------------------------
# 3. Stop the stack
# -----------------------------------------------------------------------------
echo "[2/6] stopping docker stack (${STACK_LABEL})..."
# A failed teardown may leave the volumes unreferenced but the stack in an
# unknown state; wiping then would lose the database for nothing.
if ! ./scripts/docker-run "${DOCKER_RUN_ARGS[@]}" down >/dev/null 2>&1; then
    echo "  ERROR: could not stop the stack; nothing was wiped." >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# 4. Wipe volumes
# -----------------------------------------------------------------------------
echo "[3/6] removing data volumes (${VOLUMES[*]})..."
for vol in "${VOLUMES[@]}"; do
    if docker volume inspect "$vol" >/dev/null 2>&1; then
        docker volume rm "$vol" >/dev/null || { echo "  ERROR: could not remove volume $vol; stopping before any migration. Stop whatever uses it and retry."; exit 1; }
    fi
done

remaining="$(docker volume ls --format '{{.Name}}' | grep -E "$VOLUME_RE" || true)"
if [[ "$IS_DEVNET" -eq 0 ]]; then
    # On the mainnet/testnet path our VOLUME_RE intentionally matches
    # demos_<single>_<single> and would catch idle devnet siblings.
    # Filter them out so the warning stays accurate.
    remaining="$(echo "$remaining" | grep -v '_devnet$' || true)"
fi
if [[ "$WIPE_SIGNING" -eq 0 ]]; then
    remaining="$(echo "$remaining" | grep -vx "$STATE_VOLUME" || true)"
fi
if [[ -n "$remaining" ]]; then
    echo "  WARN: leftover demos_* volumes still present (may shadow the wipe):"
    echo "$remaining" | sed 's/^/    /'
fi

# -----------------------------------------------------------------------------
# 5. Rebuild image
# -----------------------------------------------------------------------------
if [[ "$DO_REBUILD" -eq 1 ]]; then
    echo "[4/6] rebuilding node image (--no-cache)..."
    ./scripts/docker-run "${DOCKER_RUN_ARGS[@]}" --rebuild build
else
    echo "[4/6] skipping image rebuild (--no-rebuild)."
fi

# -----------------------------------------------------------------------------
# 6. Boot
# -----------------------------------------------------------------------------
echo "[5/6] booting stack..."
# --clean removes only the PG-data and node-data volumes, which step 3 already
# removed, and makes docker-run create the schema on the empty database: the
# node no longer migrates at boot.
./scripts/docker-run "${DOCKER_RUN_ARGS[@]}" --clean up -d

# -----------------------------------------------------------------------------
# 7. Tail genesis log lines
# -----------------------------------------------------------------------------
echo "[6/6] tailing GENESIS / FORK / BALANCES log lines (Ctrl-C to stop)."
echo "      Expect to see:"
echo "        [GENESIS][BALANCES] overlaying N entries from genesisData.balances"
echo "        [GENESIS][BALANCES] overlay done — total=N updated=X inserted=Y"
echo "        [FORKS] Loaded fork \"osDenomination\" with activationHeight=0"
echo
if [[ -n "$COMPOSE_PROJECT" ]]; then
    docker compose -p "$COMPOSE_PROJECT" logs -f node 2>&1 \
        | grep --line-buffered -E "GENESIS|BALANCES|FORK"
else
    docker compose logs -f node 2>&1 \
        | grep --line-buffered -E "GENESIS|BALANCES|FORK"
fi
