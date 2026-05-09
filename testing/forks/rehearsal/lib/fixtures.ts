/**
 * Seeding helpers for rehearsal scenarios that need synthetic state
 * beyond the genesis defaults — primarily the cap-policy test, which
 * needs a legacy GCR row whose post-fork OS value exceeds
 * LEGACY_NUMBER_CAP.
 *
 * All fixtures are idempotent. A scenario may call them multiple times
 * during phases without corrupting state.
 */

import { sleep } from "./devnetControl"
import { getLegacyGcrBalance, seedLegacyGcrRow } from "./nodeQueries"

/**
 * Seeds a single overflow account on every supplied node, then **reads
 * it back** on each node to confirm the row is durably persisted before
 * returning. The read-back is the deterministic-wait fix for the race
 * diagnosed in Run 4 (REHEARSAL_RESULTS.md): without it, the harness
 * could observe a successful INSERT round-trip but the migration could
 * still fire at activation height before the row was committed/visible
 * on every node.
 *
 * The post-fork OS value (10 million × 10^9 = 10^16) is well above the
 * cap (~8.1 × 10^15), so the migration's loud-cap path is exercised.
 *
 * Idempotency: the INSERT is unconstrained on `public_key` (the column
 * has no UNIQUE), so re-calling will accumulate rows. Callers should
 * invoke this exactly once per scenario run.
 */
export async function seedCapOverflowFixture(
    nodeIds: number[],
    publicKey = "0xrehearsal_cap_overflow_account",
    balanceDem = 10_000_000,
): Promise<void> {
    for (const id of nodeIds) {
        await seedLegacyGcrRow(id, publicKey, balanceDem)
    }

    // Verify-after-seed: poll each node until the row is observable via a
    // fresh SELECT. This closes the race window where the INSERT round
    // trip resolved but the row wasn't yet visible to the migration's
    // own transactional read at activation height. The poll is bounded
    // and cheap — every iteration is a single indexed lookup.
    const POLL_TIMEOUT_MS = 30_000
    const POLL_INTERVAL_MS = 250
    for (const id of nodeIds) {
        const start = Date.now()
        let observed: number | null = null
        while (Date.now() - start < POLL_TIMEOUT_MS) {
            observed = await getLegacyGcrBalance(id, publicKey).catch(() => null)
            if (observed !== null && observed === balanceDem) break
            await sleep(POLL_INTERVAL_MS)
        }
        if (observed === null || observed !== balanceDem) {
            throw new Error(
                `seedCapOverflowFixture: node-${id} did not observe seeded ` +
                    `legacy GCR row (publicKey=${publicKey}, ` +
                    `expected=${balanceDem}, observed=${String(observed)}) ` +
                    `within ${POLL_TIMEOUT_MS}ms`,
            )
        }
    }
}
