/**
 * Cross-node assertion helpers.
 *
 * Scenario scripts read the rich state objects they need; these helpers
 * collapse common multi-node convergence checks into one-line calls so
 * every scenario verifies the same shape of "all nodes agree".
 */

import {
    getBlockHashFromDb,
    getForkStateRow,
    getLastBlockNumber,
    getNetworkInfo,
    sumAllBalances,
    type ForkStateRow,
} from "./nodeQueries"

/** Throw if not. Used for declarative assertions in scenario scripts. */
export function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`Assertion failed: ${msg}`)
}

/** Fetches the head height for every supplied node, in parallel. */
export async function getHeights(
    nodeIds: number[],
): Promise<Record<number, number>> {
    const heights = await Promise.all(
        nodeIds.map(async id => [id, await getLastBlockNumber(id)] as const),
    )
    return Object.fromEntries(heights)
}

/** True iff every node reports `getNetworkInfo.osDenomination.activated`. */
export async function allActivated(nodeIds: number[]): Promise<boolean> {
    for (const id of nodeIds) {
        const info = await getNetworkInfo(id)
        if (!info?.forks?.osDenomination?.activated) return false
    }
    return true
}

/** True iff every node has reached `>= height`. */
export async function allReachedHeight(
    nodeIds: number[],
    height: number,
): Promise<boolean> {
    const heights = await getHeights(nodeIds)
    return nodeIds.every(id => (heights[id] ?? 0) >= height)
}

/**
 * Asserts every node returns the same hash for `height`. Reads from
 * Postgres directly to bypass any RPC caching.
 */
export async function assertBlockHashConvergence(
    nodeIds: number[],
    height: number,
): Promise<string> {
    const hashes = await Promise.all(
        nodeIds.map(async id => [id, await getBlockHashFromDb(id, height)] as const),
    )
    const unique = new Set(hashes.map(([, h]) => h ?? "<null>"))
    if (unique.size !== 1) {
        throw new Error(
            `Block hash divergence at height ${height}: ` +
                hashes.map(([id, h]) => `node-${id}=${h}`).join(", "),
        )
    }
    const h = hashes[0][1]
    if (!h) {
        throw new Error(`No block found at height ${height} on any node`)
    }
    return h
}

/**
 * Asserts every node has identical `fork_state` (modulo the
 * `applied_at` timestamp which is per-node). Returns one of the rows
 * for downstream inspection.
 */
export async function assertForkStateConvergence(
    nodeIds: number[],
): Promise<ForkStateRow> {
    const rows = await Promise.all(
        nodeIds.map(async id => [id, await getForkStateRow(id)] as const),
    )
    // Narrow rows so downstream uses can't see `null`. The throws above
    // already guarantee non-null, but re-mapping here keeps the type
    // system happy without bang assertions.
    const narrowedRows: Array<readonly [number, ForkStateRow]> = rows.map(
        ([id, row]) => {
            if (!row) {
                throw new Error(`Node ${id} has no fork_state row`)
            }
            return [id, row] as const
        },
    )
    const first = narrowedRows[0][1]
    const fields: Array<keyof ForkStateRow> = [
        "fork_name",
        "applied_at_block",
        "pre_sum_dem",
        "post_sum_os",
        "gcr_v2_row_count",
        "legacy_row_count",
        "validators_row_count",
        "capped_count",
        "total_value_lost_os",
    ]
    for (const [id, row] of narrowedRows) {
        for (const f of fields) {
            if (String(row[f]) !== String(first[f])) {
                throw new Error(
                    `fork_state.${String(f)} divergence: ` +
                        `node-${nodeIds[0]}=${String(first[f])} ` +
                        `vs node-${id}=${String(row[f])}`,
                )
            }
        }
    }
    return first
}

/**
 * Asserts the post-fork sum equals `preSumDem * 10^9 - totalValueLostOs`
 * on every supplied node, AND that all nodes have the same post-sum.
 */
export async function assertSumInvariantConvergence(
    nodeIds: number[],
    preSumDem: bigint,
    totalValueLostOs: bigint,
): Promise<bigint> {
    const expected = preSumDem * 1_000_000_000n - totalValueLostOs
    const sums = await Promise.all(
        nodeIds.map(async id => [id, await sumAllBalances(id)] as const),
    )
    for (const [id, s] of sums) {
        if (s !== expected) {
            throw new Error(
                `Sum invariant violated on node-${id}: ` +
                    `expected=${expected.toString()} actual=${s.toString()}`,
            )
        }
    }
    const first = sums[0][1]
    for (const [id, s] of sums) {
        if (s !== first) {
            throw new Error(
                `Sum mismatch across nodes: node-${nodeIds[0]}=${first.toString()} ` +
                    `vs node-${id}=${s.toString()}`,
            )
        }
    }
    return first
}
