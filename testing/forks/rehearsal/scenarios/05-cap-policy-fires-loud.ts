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
 *  - 4 nodes on `genesis-fork-overflow.json` (act=10). The higher
 *    activation height (vs `genesis-fork-low.json`'s 5) buys us a
 *    comfortable seeding window: with CONSENSUS_TIME=10, ~9 blocks of
 *    pre-fork lead time means the harness has well over a minute to
 *    insert the legacy GCR overflow row and confirm it landed before
 *    the migration fires at block 10.
 *  - The legacy GCR cannot be seeded from `balances` in the genesis
 *    JSON (that path only feeds `gcr_main`), so we still INSERT the
 *    row over SQL after node startup — but with verify-after-seed
 *    (see `seedCapOverflowFixture`) so the harness no longer races
 *    block production.
 *  - Before the network crosses height 10, seed each node's
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
    GENESIS_FORK_OVERFLOW,
    logsFull,
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
const ACTIVATION_HEIGHT = 10

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_OVERFLOW)
    up({ build: true })

    // Wait until each node has produced at least one block (so TypeORM's
    // `synchronize: true` has materialised the `global_change_registry`
    // table) but BEFORE crossing the activation height. With act=10 and
    // CONSENSUS_TIME=10, we want all 4 nodes in [1, ACTIVATION_HEIGHT-3]
    // before we touch the schema; that leaves ~3 blocks (~30 s real
    // time) of pre-fork window to INSERT and verify the seed, with the
    // verify-after-seed loop providing belt-and-braces against any
    // Postgres replication or write-visibility delays.
    const SEED_BY_HEIGHT = ACTIVATION_HEIGHT - 3
    await waitFor(
        async () => {
            const tips = await Promise.all(
                NODE_IDS.map(id => getLastBlockNumber(id).catch(() => -1)),
            )
            return tips.every(t => t >= 1 && t < SEED_BY_HEIGHT)
        },
        {
            description: `every node booted past block 0 but tip < ${SEED_BY_HEIGHT}`,
            timeoutMs: 240_000,
            intervalMs: 1_500,
        },
    )

    // Seed the overflow row on every node. The migration will read it
    // when it fires at height 10. `seedCapOverflowFixture` does a
    // verify-after-seed read-back per node, so this returns only when
    // every node's `global_change_registry` has the row visible.
    await seedCapOverflowFixture(NODE_IDS)
    ctx.notes.push("seeded cap-overflow legacy account on all nodes (verified)")

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

    // Loud-cap log check on every node. Use the FULL log buffer rather
    // than `--tail`: by the time we assert here, the network has produced
    // dozens of post-fork blocks and each is ~hundreds of log lines, so a
    // tail of 800 (or even 5_000) reliably misses the CAP banner that
    // was emitted near activation height. `logsFull` runs `docker
    // compose logs` with no truncation; the grep below is O(buffer) but
    // only runs once per node.
    for (const id of NODE_IDS) {
        const l = logsFull(`node-${id}`)
        if (!/CAP applied/i.test(l)) {
            throw new Error(
                `node-${id} did NOT log "CAP applied" near activation. ` +
                    `Tail sample:\n${l.slice(-2_000)}`,
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
