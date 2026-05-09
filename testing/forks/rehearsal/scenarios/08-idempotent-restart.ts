/**
 * Scenario 8 — Idempotent restart (HIGHEST STAKES).
 *
 * Goal: a node that already crossed the fork can crash and restart
 * without re-running the migration. Migration must be exactly-once or
 * balances would be multiplied by 10^9 a second time, diverging the
 * network state catastrophically.
 *
 * Setup:
 *  - 4 nodes on `genesis-fork-low.json` (act=5).
 *
 * Action:
 *  1. Bring up. Wait for all to cross fork.
 *  2. Snapshot fork_state and a sample of gcr_main from node-4.
 *  3. `docker kill demos-devnet-node-4` (ungraceful).
 *  4. `docker compose start node-4`.
 *  5. Re-snapshot. Compare.
 *
 * Asserts:
 *  - fork_state.applied still true on node-4.
 *  - fork_state.applied_at unchanged across restart (proving the
 *    migration was NOT re-run; if it had run again, the timestamp would
 *    have been UPSERTed).
 *  - Sample balances unchanged (no second × 10^9 multiplication).
 *  - No "starting state migration" log line emerges after restart.
 *
 * Failure mode caught: idempotency gate is broken; double-migration.
 * This is the doomsday bug.
 */

import {
    GENESIS_FORK_LOW,
    killService,
    logs,
    regenerateIdentities,
    sleep,
    stageGenesis,
    startService,
    up,
    waitFor,
} from "../lib/devnetControl"
import {
    allReachedHeight,
    assertForkStateConvergence,
} from "../lib/assertions"
import {
    getForkStateRow,
    getLastBlockNumber,
    query,
} from "../lib/nodeQueries"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 5

/**
 * Coerce a pg-returned `applied_at` value to epoch milliseconds. The pg
 * driver may hydrate `TIMESTAMPTZ` columns to either a JS `Date` (default
 * type parser) or an ISO string (when selected as text). We accept both
 * shapes and collapse to a wall-clock-comparable number so the
 * idempotency assertion does not fire on object-identity differences.
 */
function toEpochMs(value: string | Date): number {
    if (value instanceof Date) return value.getTime()
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) {
        throw new Error(`Unparseable applied_at value: ${String(value)}`)
    }
    return parsed
}

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_LOW)
    up({ build: true })

    await waitFor(
        async () => allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1),
        {
            description: `all nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push("all nodes crossed fork")

    // Pre-crash snapshot for node-4.
    const fsBefore = await getForkStateRow(4)
    if (!fsBefore) throw new Error("fork_state row missing on node-4 pre-crash")
    if (!fsBefore.applied) throw new Error("fork_state.applied=false pre-crash")
    const sampleBefore = await query<{ pubkey: string; balance: string }>(
        4,
        "SELECT pubkey, balance::text FROM gcr_main ORDER BY pubkey LIMIT 5",
    )
    ctx.notes.push(
        `pre-crash node-4 fork_state.applied_at=${fsBefore.applied_at} ` +
            `sample balances=${sampleBefore.map(r => r.balance).join(",")}`,
    )

    // Convergence sanity before crash.
    await assertForkStateConvergence(NODE_IDS)

    // Ungraceful crash.
    killService("node-4")
    // Allow some time for the container to exit.
    await sleep(5_000)
    startService("node-4")

    // Wait for node-4 to come back and reach roughly the peer tip.
    await waitFor(
        async () => {
            const tips = await Promise.all(
                NODE_IDS.map(id => getLastBlockNumber(id).catch(() => -1)),
            )
            const peerTip = Math.min(...tips.slice(0, 3))
            const node4 = tips[3]
            return node4 >= peerTip - 2 && node4 >= ACTIVATION_HEIGHT
        },
        {
            description: "node-4 catches up after restart",
            timeoutMs: 180_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push(`node-4 restarted; tip=${await getLastBlockNumber(4)}`)

    // Post-restart snapshot.
    const fsAfter = await getForkStateRow(4)
    if (!fsAfter) throw new Error("fork_state row missing on node-4 post-restart")
    if (!fsAfter.applied) throw new Error("fork_state.applied=false post-restart")
    // The pg driver hydrates `TIMESTAMPTZ` columns into JS `Date` instances,
    // so a naive `!==` always compares object identity and is *always* true
    // even when the wall-clock matches. The migration writes `applied_at`
    // via `new Date().toISOString()`, but on read we may also see a string
    // depending on the driver path (e.g. when columns are selected via
    // `*::text`). Coerce to a stable wall-clock representation before
    // comparing — `.getTime()` for Dates, ISO string parse for strings —
    // so the assertion correctly proves the timestamp did NOT change.
    const beforeMs = toEpochMs(fsBefore.applied_at)
    const afterMs = toEpochMs(fsAfter.applied_at)
    if (beforeMs !== afterMs) {
        throw new Error(
            "fork_state.applied_at changed across restart: " +
                `before=${fsBefore.applied_at} after=${fsAfter.applied_at}` +
                " — migration was re-run (idempotency broken)",
        )
    }
    ctx.notes.push(
        `fork_state.applied_at unchanged across restart: ${fsAfter.applied_at}`,
    )

    const sampleAfter = await query<{ pubkey: string; balance: string }>(
        4,
        "SELECT pubkey, balance::text FROM gcr_main ORDER BY pubkey LIMIT 5",
    )
    if (
        sampleAfter.length !== sampleBefore.length ||
        sampleAfter.some((r, i) => r.balance !== sampleBefore[i].balance)
    ) {
        throw new Error(
            "gcr_main sample changed across restart — possible double-migration. " +
                `before=${sampleBefore.map(r => `${r.pubkey}:${r.balance}`).join(",")} ` +
                `after=${sampleAfter.map(r => `${r.pubkey}:${r.balance}`).join(",")}`,
        )
    }
    ctx.notes.push("gcr_main sample identical across restart")

    // No "starting state migration" line should appear *after* the restart.
    // We grep the last 200 log lines for the migration banner — if the
    // migration were re-run, the banner would be among the most recent
    // entries.
    const tail = logs("node-4", 200)
    // The line is logged *only* by runOsDenominationMigration.
    const matches = tail.match(/starting state migration/g) ?? []
    // It MAY have appeared once during the original cross-fork, but only
    // pre-crash. After `docker kill` + start, the recent log buffer
    // primarily covers post-restart; finding the line there indicates a
    // re-run. Heuristically: there should be at most one occurrence in
    // the entire tail (the original migration), so > 1 is a fail.
    if (matches.length > 1) {
        throw new Error(
            `Migration banner appears ${matches.length}× in node-4 recent logs ` +
                "— double-migration suspected.",
        )
    }
    ctx.notes.push(
        `migration banner count in recent node-4 logs: ${matches.length} (≤ 1 is OK)`,
    )
}

await runScenarioCli("08-idempotent-restart", scenario)
