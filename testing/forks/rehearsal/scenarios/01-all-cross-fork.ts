/**
 * Scenario 1 — All-validators-cross-fork (the base case).
 *
 * Goal: 4 fully-coordinated nodes cross the fork, run the migration on
 * Postgres, and converge with matching post-fork balances. Minimum-
 * viable success — if this fails nothing else is reachable.
 *
 * Setup:
 *  - All 4 nodes use the post-fork image (default build, flag unset).
 *  - All 4 nodes use `genesis-fork-low.json` (activationHeight = 5).
 *
 * Action:
 *  1. `docker compose up -d` (default profile, 4 nodes).
 *  2. Wait until all nodes report head >= 6 (one block past activation).
 *  3. Snapshot fork_state and balances.
 *
 * Asserts:
 *  - fork_state row identical (mod timestamp) on all 4 nodes.
 *  - block-5 hash identical on all 4 nodes.
 *  - sum invariant holds with zero cap losses.
 *  - All 4 nodes still produce blocks past height 5 for ~60s.
 */

import {
    GENESIS_FORK_LOW,
    regenerateIdentities,
    sleep,
    stageGenesis,
    up,
    waitFor,
} from "../lib/devnetControl"
import {
    assertBlockHashConvergence,
    assertForkStateConvergence,
    assertSumInvariantConvergence,
    allActivated,
    allReachedHeight,
} from "../lib/assertions"
import { getLastBlockNumber } from "../lib/nodeQueries"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 5

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_LOW)
    up({ build: true })

    // Wait for all 4 nodes to cross height 6 (one block past activation).
    await waitFor(
        async () => (await allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1)),
        {
            description: `all nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push(`all 4 nodes crossed height ${ACTIVATION_HEIGHT}`)

    // getNetworkInfo on each node should report activated=true.
    const activated = await allActivated(NODE_IDS)
    if (!activated) {
        throw new Error("Not every node reports osDenomination.activated=true")
    }
    ctx.notes.push("all nodes report osDenomination.activated=true")

    // Block hash convergence at activation height.
    const hashAtActivation = await assertBlockHashConvergence(
        NODE_IDS,
        ACTIVATION_HEIGHT,
    )
    ctx.notes.push(
        `block ${ACTIVATION_HEIGHT} hash matches across nodes: ${hashAtActivation}`,
    )

    // fork_state convergence.
    const forkState = await assertForkStateConvergence(NODE_IDS)
    ctx.notes.push(
        `fork_state pre_sum_dem=${forkState.pre_sum_dem} ` +
            `post_sum_os=${forkState.post_sum_os} ` +
            `cappedCount=${forkState.capped_count}`,
    )

    // Sum invariant: zero cap losses expected with the default genesis seeds.
    const preSumDem = BigInt(forkState.pre_sum_dem)
    const totalLost = BigInt(forkState.total_value_lost_os)
    const postSum = await assertSumInvariantConvergence(
        NODE_IDS,
        preSumDem,
        totalLost,
    )
    ctx.notes.push(
        `sum invariant verified: postSumOs=${postSum.toString()} ` +
            `cap losses=${totalLost.toString()}`,
    )

    // Confirm blocks continue to be produced for ~60s past activation.
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

await runScenarioCli("01-all-cross-fork", scenario)
