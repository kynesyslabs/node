#!/bin/bash
# Runs the fork-activation rehearsal scenarios in dependency order.
#
# Per REHEARSAL_PLAN.md §4 + DEM-665 P10b, the order is:
#   1. Scenario 4 — genesis-hash-invariance          (must be first)
#   2. Scenario 1 — all-validators-cross-fork        (base case)
#   3. Scenario 7 — sum-invariant-audit
#   4. Scenario 8 — idempotent-restart
#   5. Scenario 5 — cap-policy-fires-loud
#   6. Scenario 6 — mid-flight-tx
#   7. Scenario 2 — validator-desync-recovery
#   8. Scenario 3 — fresh-node-post-fork             (decimals last)
#   9. Scenario 9 — gasFeeSeparation co-activation   (DEM-665)
#  10. Scenario 10 — burn-spend-rejection            (DEM-665, placeholder)
#
# Exits non-zero on the first failure; subsequent scenarios are skipped.
# Pass `--keep-state` to leave the devnet running on a failure for
# operator inspection (`docker compose -f testing/devnet/docker-compose.yml ps`).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SCENARIOS=(
    "scenarios/04-genesis-hash-invariance.ts"
    "scenarios/01-all-cross-fork.ts"
    "scenarios/07-sum-invariant-audit.ts"
    "scenarios/08-idempotent-restart.ts"
    "scenarios/05-cap-policy-fires-loud.ts"
    "scenarios/06-mid-flight-tx.ts"
    "scenarios/02-validator-desync-recovery.ts"
    "scenarios/03-fresh-node-post-fork.ts"
    "scenarios/09-fee-distribution.ts"
    "scenarios/10-burn-spend-rejection.ts"
)

EXTRA_ARGS=()
for arg in "$@"; do
    EXTRA_ARGS+=("${arg}")
done

START_TIME=$(date +%s)
RESULTS=()

cd "${REPO_ROOT}"

for s in "${SCENARIOS[@]}"; do
    NAME="$(basename "${s}" .ts)"
    echo ""
    echo "########################################################################"
    echo "# RUN: ${NAME}"
    echo "########################################################################"
    SCEN_START=$(date +%s)
    if bun run "testing/forks/rehearsal/${s}" "${EXTRA_ARGS[@]}"; then
        SCEN_END=$(date +%s)
        RESULTS+=("PASS  ${NAME}  $((SCEN_END - SCEN_START))s")
    else
        SCEN_END=$(date +%s)
        RESULTS+=("FAIL  ${NAME}  $((SCEN_END - SCEN_START))s")
        echo ""
        echo "!!! ${NAME} FAILED — skipping remaining scenarios !!!"
        break
    fi
done

END_TIME=$(date +%s)

echo ""
echo "========================================================================"
echo "REHEARSAL SUMMARY"
echo "========================================================================"
for r in "${RESULTS[@]}"; do
    echo "${r}"
done
echo "------------------------------------------------------------------------"
echo "Total wall-clock: $((END_TIME - START_TIME))s"
echo "========================================================================"

# Exit non-zero if any scenario failed.
for r in "${RESULTS[@]}"; do
    if [[ "${r}" == FAIL* ]]; then
        exit 1
    fi
done
exit 0
