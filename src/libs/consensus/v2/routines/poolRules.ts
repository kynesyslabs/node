/**
 * Which identities may sign a block, as a function of chain data alone. The
 * node applies these rules to its database in getShard; an outside client
 * applies the same ones to a block's committed peerlist and a validator set
 * it holds, so both must import them from here rather than restate them.
 */

/**
 * Explicit lexicographic comparator for identity strings. Behaviourally
 * identical to a bare `.sort()` on strings, but stated outright because
 * peerlist ordering is consensus-relevant and the default comparator's
 * implicit stringification is a Sonar CI gate failure.
 */
export function compareIdentities(a: string, b: string): number {
    if (a === b) return 0
    return a < b ? -1 : 1
}

/**
 * How the eligible pool was formed: the committed peerlist filtered by the
 * staked set, the peerlist alone (no staked set: development networks only),
 * or the staked set alone (the block committed no peerlist).
 */
export type EligiblePoolSource = "peerlist" | "unfiltered" | "validators"

export interface EligiblePool {
    pool: string[]
    source: EligiblePoolSource
}

/**
 * The eligible pool from a block's committed peerlist (lowercase) and the
 * staked identities it is filtered by: deduplicated and sorted, so every
 * holder of the same chain data computes the same list. Null when neither
 * source names anyone.
 */
export function eligiblePoolFrom(
    committed: string[],
    validators: Set<string>,
): EligiblePool | null {
    let pool: string[]
    let source: EligiblePoolSource
    if (committed.length > 0 && validators.size > 0) {
        pool = committed.filter(id => validators.has(id))
        source = "peerlist"
    } else if (committed.length > 0) {
        pool = committed
        source = "unfiltered"
    } else if (validators.size > 0) {
        pool = [...validators]
        source = "validators"
    } else {
        return null
    }
    return { pool: [...new Set(pool)].sort(compareIdentities), source }
}

/**
 * The pool a bound committee is drawn from: the eligible pool, or the whole
 * staked set when the pool holds fewer than `floor` identities and the
 * staked set is larger. A shrunken peerlist would otherwise stop the chain
 * for good.
 */
export function boundPoolFrom(
    pool: string[],
    staked: Set<string>,
    floor: number,
): string[] {
    if (pool.length >= floor || staked.size <= pool.length) return pool
    return [...staked].sort(compareIdentities)
}

/**
 * Under `peerlistFloor`, the committee of every block at a multiple of this
 * height is drawn from a wider pool (`poolRefreshHeights`). It is the
 * longest a committee of `q` colluders keeps the chain with coalition-only
 * peerlists. About 84 minutes at a 7 s block time.
 */
export const POOL_REFRESH_INTERVAL = 720

/**
 * How many earlier refresh blocks a refresh unites. A refresh misses the
 * honest set only if every one of them was signed by a captured committee;
 * a deeper window also brings back more validators that have since gone
 * offline, and enough of them in one committee stall its height.
 */
export const POOL_REFRESH_DEPTH = 3

/** Whether block `height` draws its committee from the refreshed pool. */
export function isPoolRefreshHeight(height: number): boolean {
    return height > 0 && height % POOL_REFRESH_INTERVAL === 0
}

/**
 * The earlier refresh blocks whose committed peerlists the pool of block
 * `height` unites with its parent's, newest first. While the window reaches
 * back past the first refresh block it ends with 0, which stands for the
 * genesis validator set: genesis commits no peerlist, and without it a
 * coalition that captured the lists before the first refresh would find
 * only its own lists to sample.
 */
export function poolRefreshHeights(height: number): number[] {
    const heights: number[] = []
    for (let j = 1; j <= POOL_REFRESH_DEPTH; j++) {
        const sample = height - j * POOL_REFRESH_INTERVAL
        if (sample < 1) {
            heights.push(0)
            break
        }
        heights.push(sample)
    }
    return heights
}

/**
 * The parent's committed peerlist united with the sampled ones. An empty
 * parent list stays empty, so the bootstrap rule in eligiblePoolFrom (the
 * whole staked set) still applies to it.
 */
export function refreshedPeerlist(
    committed: string[],
    samples: string[][],
): string[] {
    if (committed.length === 0) return committed
    return [...new Set([...committed, ...samples.flat()])].sort(compareIdentities)
}
