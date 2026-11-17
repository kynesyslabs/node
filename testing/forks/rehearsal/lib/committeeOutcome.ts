/**
 * What the chain must do after the k-th of a series of one-at-a-time stops
 * (testing/devnet/quorum-drills/run.sh, the `drop-*` scenarios).
 *
 *   bun testing/forks/rehearsal/lib/committeeOutcome.ts <validators> <shardSize> <k>
 *
 * prints `<outcome> pool=<p> committee=<c> worstLive=<w> bestLive=<b> need=<q>`,
 * outcome being `progress`, `stall` or `draw` (no pass criterion: it depends
 * on which validators the committee draw picks). Exit 2 on bad arguments.
 *
 * The model, from src/libs/consensus/v2 with committeeBinding active (README
 * "Which validators are stopped"):
 *  - the committee of block B is min(shardSize, pool) identities drawn from
 *    the peerlist committed in B-1; an offline member stays in it and counts
 *    as a missing vote, and every retry at a height draws the same committee;
 *  - a block needs `committeeFloor(shardSize)` live members to be forged and
 *    `signatureQuorum(shardSize, pool)` signatures to be valid;
 *  - a stopped validator leaves the pool once the chain has moved past the
 *    height it stopped at (the peerlist lists only peers seen at the parent).
 *
 * The drop drills stop one validator, wait for the chain to move (or to
 * stall), then stop the next. So at the k-th stop the k-1 earlier victims have
 * already left the pool: the first block after the stop draws from N-k+1
 * identities of which one, the new victim, is down; once that block lands the
 * pool is the N-k live validators. With N <= shardSize this is exactly the
 * rule run.sh used before (progress iff N-k >= q); with N > shardSize at most
 * one down validator can be in any committee, so the chain keeps forging as
 * long as min(shardSize, N-k) live validators reach q.
 */

import { committeeFloor, signatureQuorum } from "./haltDrill"

export type StopOutcome = "progress" | "stall" | "draw"

export interface StopOutcomeDetail {
    outcome: StopOutcome
    /** Identities the first block after the stop is drawn from. */
    pool: number
    committee: number
    /** Live committee members when the draw includes the new victim. */
    worstLive: number
    /** Live committee members when it does not (only possible when pool > committee). */
    bestLive: number
    /** Live members the first block needs. */
    need: number
}

function needed(shardSize: number, pool: number): number {
    return Math.max(committeeFloor(shardSize), signatureQuorum(shardSize, pool))
}

/** Outcome of the k-th one-at-a-time stop (k >= 1) of `validators` at `shardSize`. */
export function sequentialStopOutcome(validators: number, shardSize: number, k: number): StopOutcomeDetail {
    for (const [name, v] of [["validators", validators], ["shardSize", shardSize], ["k", k]] as const) {
        if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be an integer >= 1, got ${v}`)
    }
    if (k > validators) throw new RangeError(`cannot stop ${k} of ${validators} validators`)
    const pool = validators - (k - 1)
    const committee = Math.min(shardSize, pool)
    const worstLive = committee - 1
    const bestLive = pool > committee ? committee : committee - 1
    const need = needed(shardSize, pool)
    // Once the victim has left the pool every member is live
    const after = pool - 1
    const steady = after >= 1 && Math.min(shardSize, after) >= needed(shardSize, after)
    let outcome: StopOutcome
    if (!steady) outcome = "stall"
    else if (worstLive >= need) outcome = "progress"
    else if (bestLive >= need) outcome = "draw"
    else outcome = "stall"
    return { outcome, pool, committee, worstLive, bestLive, need }
}

export function main(argv: string[]): number {
    const nums = argv.map(Number)
    if (argv.length !== 3 || nums.some(v => !Number.isInteger(v))) {
        process.stderr.write("usage: committeeOutcome.ts <validators> <shardSize> <k>\n")
        return 2
    }
    try {
        const d = sequentialStopOutcome(nums[0], nums[1], nums[2])
        process.stdout.write(
            `${d.outcome} pool=${d.pool} committee=${d.committee} worstLive=${d.worstLive} ` +
                `bestLive=${d.bestLive} need=${d.need}\n`,
        )
        return 0
    } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
        return 2
    }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
