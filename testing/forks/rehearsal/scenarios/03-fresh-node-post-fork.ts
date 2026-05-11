/**
 * Scenario 3 — Fresh node post-fork (HIGHEST STAKES).
 *
 * Goal: a node that joins AFTER the fork has happened can sync the
 * entire chain from genesis (replaying both pre- and post-fork blocks)
 * and end up converged with the others. Validates the static-trace
 * claim from Session 14 — that the migration hook fires correctly
 * during historical replay.
 *
 * Setup:
 *  - Nodes 1-4 use post-fork image, `genesis-fork-low.json` (act=5).
 *  - Node-5 is gated behind the docker-compose `rehearsal` profile.
 *  - 5 identities + a 5-entry peerlist generated up front.
 *
 * Action:
 *  1. Bring up nodes 1-4. Wait for fork crossing.
 *  2. Let the network advance to height ~50 (post-fork by a margin).
 *  3. Bring up node-5 (`--profile rehearsal`).
 *  4. Wait for node-5 to sync to current height.
 *
 * Asserts:
 *  - node-5 catches up to peer tip.
 *  - fork_state on node-5 matches nodes 1-4 (mod timestamp).
 *  - block hashes at activation height + a sample post-fork height
 *    match across all 5 nodes.
 *
 * Failure mode caught: the migration hook does not fire during
 * historical replay, leaving node-5 with pre-fork balances while it
 * tries to validate post-fork blocks. Highest-likelihood real bug.
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
    allReachedHeight,
} from "../lib/assertions"
import { getLastBlockNumber } from "../lib/nodeQueries"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODES_1_TO_4 = [1, 2, 3, 4]
const ALL_NODES = [1, 2, 3, 4, 5]
const ACTIVATION_HEIGHT = 5
const POST_FORK_TARGET = 30 // give node-5 a non-trivial backlog

async function scenario(ctx: ScenarioContext): Promise<void> {
    // Generate 5 identities up front so node-5's pubkey is in the peerlist
    // when nodes 1-4 boot.
    regenerateIdentities(5)
    stageGenesis(GENESIS_FORK_LOW)

    // Bring up only nodes 1-4 (default profile).
    up({ build: true })

    await waitFor(
        async () => allReachedHeight(NODES_1_TO_4, ACTIVATION_HEIGHT + 1),
        {
            description: `nodes 1-4 reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push("nodes 1-4 crossed fork")

    // Let the network advance well past activation.
    await waitFor(
        async () => allReachedHeight(NODES_1_TO_4, POST_FORK_TARGET),
        {
            description: `nodes 1-4 reach height >= ${POST_FORK_TARGET}`,
            timeoutMs: 480_000,
            intervalMs: 3_000,
        },
    )
    const networkTip = await getLastBlockNumber(1)
    ctx.notes.push(`network advanced to ~${networkTip} pre-join`)

    // Snapshot fork_state on the original 4 to compare later.
    const preState = await assertForkStateConvergence(NODES_1_TO_4)
    ctx.notes.push(
        "nodes 1-4 fork_state pre-join: " +
            `applied_at_block=${preState.applied_at_block} ` +
            `cappedCount=${preState.capped_count}`,
    )

    // Bring up node-5 via the rehearsal profile.
    up({ profiles: ["rehearsal"], services: ["node-5"] })

    // Wait for node-5 to catch up to peer tip (within a reasonable margin).
    await waitFor(
        async () => {
            const tips = await Promise.all(
                ALL_NODES.map(async id => [id, await getLastBlockNumber(id).catch(() => -1)] as const),
            )
            const peerTip = Math.min(...tips.filter(([id]) => id !== 5).map(([, t]) => t))
            const node5 = tips.find(([id]) => id === 5)?.[1] ?? -1
            return node5 >= peerTip - 2 && node5 >= POST_FORK_TARGET
        },
        {
            description: "node-5 syncs to peer tip",
            timeoutMs: 480_000,
            intervalMs: 3_000,
        },
    )
    ctx.notes.push(
        `node-5 caught up: tip=${await getLastBlockNumber(5)}`,
    )

    // Convergence: fork_state on node-5 matches the others.
    const allState = await assertForkStateConvergence(ALL_NODES)
    ctx.notes.push(
        "fork_state on all 5 nodes converged " +
            `(applied_at_block=${allState.applied_at_block})`,
    )

    // Block hash at the activation height must match across all 5.
    const hashAtActivation = await assertBlockHashConvergence(
        ALL_NODES,
        ACTIVATION_HEIGHT,
    )
    ctx.notes.push(
        `block ${ACTIVATION_HEIGHT} hash matches across all 5: ${hashAtActivation}`,
    )
    // Sample a post-fork height too.
    const sampleHeight = ACTIVATION_HEIGHT + 5
    const hashSample = await assertBlockHashConvergence(
        ALL_NODES,
        sampleHeight,
    )
    ctx.notes.push(
        `block ${sampleHeight} hash matches across all 5: ${hashSample}`,
    )

    // Final stability sanity-check: 30s of continued production.
    const before = await getLastBlockNumber(5)
    await sleep(30_000)
    const after = await getLastBlockNumber(5)
    if (after <= before) {
        throw new Error(
            `node-5 stalled post-sync: before=${before} after=${after}`,
        )
    }
    ctx.notes.push(`node-5 continues: ${before} -> ${after}`)
}

await runScenarioCli("03-fresh-node-post-fork", scenario)
