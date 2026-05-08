/**
 * Scenario 5 — Cap policy fires loud.
 *
 * Goal: when a legacy GCR account would overflow LEGACY_NUMBER_CAP after
 * the multiplication, the migration logs a CAP message, records the
 * forensic data in `fork_state`, and the network either (Phase A) halts
 * loudly if the policy aborts, or (Phase B, current contract) caps the
 * account, records the loss, and continues.
 *
 * Current implementation per `osDenomination.ts`: the migration applies
 * the cap, logs a WARNING, accumulates `cappedCount` and
 * `total_value_lost_os` in `fork_state`, and the sum invariant accounts
 * for the lost value. So this scenario verifies the cap-and-record
 * behaviour rather than a hard abort.
 *
 * Setup:
 *  - 4 nodes on `genesis-fork-low.json` (act=5).
 *  - Before the network crosses height 5, seed each node's
 *    `global_change_registry` with a single account holding 10M DEM.
 *    10M × 10^9 = 10^16, which exceeds LEGACY_NUMBER_CAP (~8.1×10^15).
 *
 * Asserts:
 *  - Each node's logs contain "CAP applied" near activation.
 *  - fork_state.capped_count >= 1 and total_value_lost_os > 0,
 *    identical across nodes.
 *  - Sum invariant holds with the recorded losses.
 */

import {
    GENESIS_FORK_LOW,
    logs,
    regenerateIdentities,
    sleep,
    stageGenesis,
    up,
    waitFor,
} from "../lib/devnetControl"
import {
    assertForkStateConvergence,
    assertSumInvariantConvergence,
    allReachedHeight,
} from "../lib/assertions"
import { getLastBlockNumber } from "../lib/nodeQueries"
import { seedCapOverflowFixture } from "../lib/fixtures"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 5

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_LOW)
    up({ build: true })

    // Wait until each node has at least produced its genesis row in the
    // blocks table (so the legacy GCR table exists / migrations applied),
    // but BEFORE crossing height 5.
    await waitFor(
        async () => {
            const tips = await Promise.all(
                NODE_IDS.map(id => getLastBlockNumber(id).catch(() => -1)),
            )
            return tips.every(t => t >= 1 && t < ACTIVATION_HEIGHT)
        },
        {
            description: "every node has booted past block 0 but before fork",
            timeoutMs: 240_000,
            intervalMs: 1_500,
        },
    )

    // Seed the overflow row on every node. The migration will read it
    // when it fires at height 5.
    await seedCapOverflowFixture(NODE_IDS)
    ctx.notes.push("seeded cap-overflow legacy account on all nodes")

    // Wait for fork crossing.
    await waitFor(
        async () => allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1),
        {
            description: `nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push("all nodes crossed fork")

    // Loud-cap log check on every node.
    for (const id of NODE_IDS) {
        const l = logs(`node-${id}`, 800)
        if (!/CAP applied/i.test(l)) {
            throw new Error(
                `node-${id} did NOT log "CAP applied" near activation. ` +
                    `Sample:\n${l.slice(-2_000)}`,
            )
        }
    }
    ctx.notes.push("every node logged 'CAP applied' (loud failure verified)")

    // fork_state convergence — including the cap counters.
    const fs = await assertForkStateConvergence(NODE_IDS)
    if (Number(fs.capped_count) < 1) {
        throw new Error(
            `Expected capped_count >= 1, got ${fs.capped_count}`,
        )
    }
    if (BigInt(fs.total_value_lost_os) <= 0n) {
        throw new Error(
            `Expected total_value_lost_os > 0, got ${fs.total_value_lost_os}`,
        )
    }
    ctx.notes.push(
        `fork_state convergence: cappedCount=${fs.capped_count} ` +
            `valueLostOs=${fs.total_value_lost_os}`,
    )

    // Sum invariant survives even with cap losses.
    const post = await assertSumInvariantConvergence(
        NODE_IDS,
        BigInt(fs.pre_sum_dem),
        BigInt(fs.total_value_lost_os),
    )
    ctx.notes.push(`sum invariant verified with cap losses: postSumOs=${post.toString()}`)

    // Sanity: network keeps producing for ~30s past the cap event.
    const tipBefore = await getLastBlockNumber(1)
    await sleep(30_000)
    const tipAfter = await getLastBlockNumber(1)
    if (tipAfter <= tipBefore) {
        throw new Error(
            `Network stalled past cap event: tipBefore=${tipBefore} tipAfter=${tipAfter}`,
        )
    }
    ctx.notes.push(`network advanced past cap event: ${tipBefore} -> ${tipAfter}`)
}

await runScenarioCli("05-cap-policy-fires-loud", scenario)
