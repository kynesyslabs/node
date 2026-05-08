/**
 * Seeding helpers for rehearsal scenarios that need synthetic state
 * beyond the genesis defaults — primarily the cap-policy test, which
 * needs a legacy GCR row whose post-fork OS value exceeds
 * LEGACY_NUMBER_CAP.
 *
 * All fixtures are idempotent. A scenario may call them multiple times
 * during phases without corrupting state.
 */

import { seedLegacyGcrRow } from "./nodeQueries"

/**
 * Seeds a single overflow account on every supplied node. The post-fork
 * OS value (10 million × 10^9 = 10^16) is well above the cap
 * (~8.1 × 10^15), so the migration's loud-cap path is exercised.
 */
export async function seedCapOverflowFixture(
    nodeIds: number[],
    publicKey = "0xrehearsal_cap_overflow_account",
    balanceDem = 10_000_000,
): Promise<void> {
    for (const id of nodeIds) {
        await seedLegacyGcrRow(id, publicKey, balanceDem)
    }
}
