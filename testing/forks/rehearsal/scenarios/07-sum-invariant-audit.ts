/**
 * Scenario 7 — Sum invariant audit on Postgres.
 *
 * Goal: independently verify on real Postgres that
 *   Σ(post) == Σ(pre) × 10^9 - Σ(capLosses)
 * holds across all three balance backends:
 *  - gcr_main.balance (bigint)
 *  - validators.staked_amount (text bigint-as-string)
 *  - global_change_registry.details.content.balance (JSONB number)
 *
 * Setup:
 *  - 4 nodes on `genesis-fork-mid.json` (act=10) — pre-fork window is
 *    long enough to dump pre-sums before activation.
 *
 * Action:
 *  1. Bring up. Wait until tips ∈ [3, activationHeight-1].
 *  2. Snapshot pre-sums per backend per node.
 *  3. Wait for activation crossing.
 *  4. Snapshot post-sums per backend per node.
 *  5. Read fork_state to get totalValueLostOs.
 *  6. Verify the invariant on every node.
 *
 * Failure mode caught: migration multiplies one backend but not
 * another (e.g., misses validator stakes). Unit tests cover this on
 * SQLite; this scenario covers it on Postgres with the production
 * driver.
 */

import {
    GENESIS_FORK_MID,
    regenerateIdentities,
    stageGenesis,
    up,
    waitFor,
} from "../lib/devnetControl"
import {
    allReachedHeight,
    assertForkStateConvergence,
} from "../lib/assertions"
import {
    getLastBlockNumber,
    sumGcrMain,
    sumLegacyGcr,
    sumValidatorStakes,
} from "../lib/nodeQueries"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 10

interface BackendSums {
    gcrV2: bigint
    validators: bigint
    legacy: bigint
    total: bigint
}

async function snapshotBackends(nodeId: number): Promise<BackendSums> {
    const [gcrV2, validators, legacy] = await Promise.all([
        sumGcrMain(nodeId),
        sumValidatorStakes(nodeId),
        sumLegacyGcr(nodeId),
    ])
    return { gcrV2, validators, legacy, total: gcrV2 + validators + legacy }
}

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_MID)
    up({ build: true })

    // Pre-fork window.
    await waitFor(
        async () => {
            const tips = await Promise.all(
                NODE_IDS.map(id => getLastBlockNumber(id).catch(() => -1)),
            )
            return tips.every(t => t >= 3 && t < ACTIVATION_HEIGHT)
        },
        {
            description: `every node in pre-fork window [3, ${ACTIVATION_HEIGHT - 1}]`,
            timeoutMs: 240_000,
            intervalMs: 1_500,
        },
    )

    const pre: Record<number, BackendSums> = {}
    for (const id of NODE_IDS) pre[id] = await snapshotBackends(id)
    ctx.notes.push(
        "pre-fork sums per node: " +
            NODE_IDS.map(
                id =>
                    `node-${id} total=${pre[id].total.toString()} ` +
                    `(gcrV2=${pre[id].gcrV2}, val=${pre[id].validators}, legacy=${pre[id].legacy})`,
            ).join("; "),
    )

    // All pre-sums must agree.
    const preTotalSet = new Set(NODE_IDS.map(id => pre[id].total.toString()))
    if (preTotalSet.size !== 1) {
        throw new Error(
            "Pre-fork sums disagree across nodes: " +
                NODE_IDS.map(
                    id => `node-${id}=${pre[id].total.toString()}`,
                ).join(", "),
        )
    }

    // Cross fork.
    await waitFor(
        async () => allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1),
        {
            description: `all nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )

    const post: Record<number, BackendSums> = {}
    for (const id of NODE_IDS) post[id] = await snapshotBackends(id)
    ctx.notes.push(
        "post-fork sums per node: " +
            NODE_IDS.map(
                id =>
                    `node-${id} total=${post[id].total.toString()} ` +
                    `(gcrV2=${post[id].gcrV2}, val=${post[id].validators}, legacy=${post[id].legacy})`,
            ).join("; "),
    )
    const postTotalSet = new Set(NODE_IDS.map(id => post[id].total.toString()))
    if (postTotalSet.size !== 1) {
        throw new Error(
            "Post-fork sums disagree across nodes: " +
                NODE_IDS.map(
                    id => `node-${id}=${post[id].total.toString()}`,
                ).join(", "),
        )
    }

    // Read fork_state to get capped losses.
    const fs = await assertForkStateConvergence(NODE_IDS)
    const capLost = BigInt(fs.total_value_lost_os)
    const preTotal = BigInt(pre[NODE_IDS[0]].total)
    const expectedPost = preTotal * 1_000_000_000n - capLost

    for (const id of NODE_IDS) {
        if (post[id].total !== expectedPost) {
            throw new Error(
                `Sum invariant fails on node-${id}: ` +
                    `expected=${expectedPost.toString()} ` +
                    `actual=${post[id].total.toString()} ` +
                    `(preTotal=${preTotal.toString()}, capLost=${capLost.toString()})`,
            )
        }
    }
    ctx.notes.push(
        "sum invariant verified on all 4 nodes: " +
            `preDem=${preTotal.toString()} × 10^9 - lostOs=${capLost.toString()} = ${expectedPost.toString()}`,
    )

    // Per-backend sanity: each backend's pre and post should obey
    // post = pre × 10^9 (for GCRv2 and validators which have no cap)
    // and post == pre × 10^9 - capLost for legacy.
    for (const id of NODE_IDS) {
        const expGcr = pre[id].gcrV2 * 1_000_000_000n
        if (post[id].gcrV2 !== expGcr) {
            throw new Error(
                `gcr_main on node-${id}: expected ${expGcr} got ${post[id].gcrV2}`,
            )
        }
        const expVal = pre[id].validators * 1_000_000_000n
        if (post[id].validators !== expVal) {
            throw new Error(
                `validators on node-${id}: expected ${expVal} got ${post[id].validators}`,
            )
        }
        const expLeg = pre[id].legacy * 1_000_000_000n - capLost
        if (post[id].legacy !== expLeg) {
            throw new Error(
                `legacy GCR on node-${id}: expected ${expLeg} got ${post[id].legacy}`,
            )
        }
    }
    ctx.notes.push("per-backend invariants verified on all 4 nodes")
}

await runScenarioCli("07-sum-invariant-audit", scenario)
