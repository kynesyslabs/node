/**
 * Scenario 9 — DEM-665 gasFeeSeparation co-activation.
 *
 * Goal: 4 nodes cross the combined fork (osDenomination +
 * gasFeeSeparation at the same activationHeight=5) and converge on the
 * post-activation state the DEM-665 spec requires:
 *
 *   - Both `fork_state` rows are present and identical across nodes.
 *   - The burn address (0x0000…) has a gcr_main row with balance 0.
 *   - The genesis-supplied treasury address has a gcr_main row with
 *     balance 0.
 *   - The osDenomination state migration still applies bit-identically
 *     to scenario 01 (this scenario does NOT regress decimals).
 *
 * What this scenario does NOT cover:
 *
 *   - A real native-transfer fee distribution. The rehearsal harness
 *     deliberately has no signing helper for the genesis-funded
 *     accounts (see scenario 06's note + REHEARSAL_RESULTS.md), so we
 *     cannot submit a signed tx to drive the post-fork
 *     `feeDistribution.ts` path on-chain. End-to-end fee balance
 *     deltas (sender drops by total, burn / treasury / rpc operator
 *     gain by percentages) are covered at unit level by:
 *       - tests/blockchain/feeDistribution.test.ts (16 tests)
 *       - tests/blockchain/handleNativeOperations.test.ts (5 tests)
 *
 *   - Burn-spend rejection. Same constraint — without a signing
 *     helper, the harness cannot craft a tx with a manual
 *     remove-from-burn GCREdit. Unit coverage is in
 *     tests/blockchain/GCRBalanceRoutines.test.ts (8 tests). Filed as
 *     myc#100 follow-up to add signing support if/when the rehearsal
 *     harness gains a funded-key helper.
 *
 * Setup:
 *  - All 4 nodes use the post-fork image (default build).
 *  - genesis-fork-low-gasFee.json sets both forks at activationHeight=5
 *    and carries a sentinel treasury at
 *    0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface.
 *
 * Action:
 *  1. docker compose up -d (default profile, 4 nodes).
 *  2. Wait until all nodes report head >= 6 (one block past activation).
 *  3. Snapshot fork_state, gcr_main, and balances.
 *
 * Asserts:
 *  - allActivated(NODE_IDS) for osDenomination.
 *  - Both fork_state rows are identical (mod timestamps) across nodes.
 *  - Burn account exists with balance 0 on every node.
 *  - Treasury account exists with balance 0 on every node.
 *  - osDenomination sum invariant still holds (regression guard).
 */

import {
    GENESIS_FORK_LOW_GAS_FEE,
    regenerateIdentities,
    sleep,
    stageGenesis,
    up,
    waitFor,
} from "../lib/devnetControl"
import {
    allActivated,
    allReachedHeight,
    assertBlockHashConvergence,
    assertForkStateConvergence,
    assertGasFeeForkStateConvergence,
    assertGcrAccountConvergence,
    assertSumInvariantConvergence,
} from "../lib/assertions"
import { getLastBlockNumber } from "../lib/nodeQueries"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 5

/**
 * Mirrors the genesis fixture. Lower-case hex, `0x` + 64 chars. Used
 * by the burn-address spend-prevention path and emitted as the
 * code-constant `BURN_ADDRESS` from `src/forks/migrations/gasFeeSeparation.ts`.
 */
const BURN_ADDRESS = "0x" + "0".repeat(64)
/**
 * Sentinel treasury used by the rehearsal fixture. Matches
 * testing/forks/rehearsal/genesis/genesis-fork-low-gasFee.json.
 * Production genesis ships a different (ops-owned) treasury — the
 * activation hook reads whichever address the genesis declares.
 */
const TREASURY_ADDRESS =
    "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_LOW_GAS_FEE)
    up({ build: true })

    // Wait for all 4 nodes to cross height 6 (one block past activation).
    await waitFor(
        async () => allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1),
        {
            description: `all nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push(`all 4 nodes crossed height ${ACTIVATION_HEIGHT}`)

    // osDenomination is still expected to fire at the same height —
    // scenario 9 must not regress decimals.
    const activated = await allActivated(NODE_IDS)
    if (!activated) {
        throw new Error("Not every node reports osDenomination.activated=true")
    }
    ctx.notes.push("all nodes report osDenomination.activated=true")

    // Block hash convergence at activation height (sanity guard — if
    // the gasFeeSeparation hook fired non-deterministically across
    // nodes, the block-5 hash would diverge here).
    const hashAtActivation = await assertBlockHashConvergence(
        NODE_IDS,
        ACTIVATION_HEIGHT,
    )
    ctx.notes.push(
        `block ${ACTIVATION_HEIGHT} hash matches across nodes: ${hashAtActivation}`,
    )

    // osDenomination fork_state convergence + sum invariant — same as
    // scenario 01. Regression guard: gasFeeSeparation must not change
    // anything decimals-touched.
    const osDenomState = await assertForkStateConvergence(NODE_IDS)
    ctx.notes.push(
        `osDenomination fork_state pre_sum_dem=${osDenomState.pre_sum_dem} ` +
            `post_sum_os=${osDenomState.post_sum_os} ` +
            `cappedCount=${osDenomState.capped_count}`,
    )
    const preSumDem = BigInt(osDenomState.pre_sum_dem)
    const totalLost = BigInt(osDenomState.total_value_lost_os)
    const postSum = await assertSumInvariantConvergence(
        NODE_IDS,
        preSumDem,
        totalLost,
    )
    ctx.notes.push(
        `osDenomination sum invariant holds: postSumOs=${postSum.toString()}`,
    )

    // DEM-665 — gasFeeSeparation fork_state convergence.
    const gasFeeState = await assertGasFeeForkStateConvergence(NODE_IDS)
    ctx.notes.push(
        `gasFeeSeparation fork_state applied_at_block=${gasFeeState.applied_at_block}`,
    )

    // DEM-665 — burn account exists with balance 0 on every node.
    await assertGcrAccountConvergence(
        NODE_IDS,
        BURN_ADDRESS,
        "0",
        "burn account",
    )
    ctx.notes.push(`burn account ${BURN_ADDRESS} exists at balance 0`)

    // DEM-665 — treasury account exists with balance 0 on every node.
    await assertGcrAccountConvergence(
        NODE_IDS,
        TREASURY_ADDRESS,
        "0",
        "treasury account",
    )
    ctx.notes.push(
        `treasury account ${TREASURY_ADDRESS} exists at balance 0`,
    )

    // Confirm blocks continue to be produced for ~60s past activation
    // — same liveness check scenario 01 runs.
    const tipBefore = await getLastBlockNumber(1)
    await sleep(60_000)
    const tipAfter = await getLastBlockNumber(1)
    if (tipAfter <= tipBefore) {
        throw new Error(
            `Network stalled past activation: tipBefore=${tipBefore} tipAfter=${tipAfter}`,
        )
    }
    ctx.notes.push(
        `network advanced over 60s: ${tipBefore} -> ${tipAfter}`,
    )
}

await runScenarioCli("09-fee-distribution", scenario)
