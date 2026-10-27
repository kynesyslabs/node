import GCR from "src/libs/blockchain/gcr/gcr"
import { PeerManager } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { getStakedSet } from "./stakedSet"
import { getEligiblePool } from "./v2/routines/getShard"

function describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

/**
 * Whether `sender` may take part in the consensus mempool merge: whoever
 * shard selection itself would admit.
 *
 *  1. In the active validator set at the local head.
 *  2. The set is empty and `DEMOS_REQUIRE_VALIDATORS` is not "true": a bare
 *     development network has no validator rows (they are seeded only from a
 *     snapshot), so shard selection falls back to the nodes it can see, and
 *     the merge must do the same or every node would know only its own pool.
 *     Only a node this one already knows qualifies.
 *  3. In the eligible pool at the head (committed peerlist, same rule as
 *     shard selection).
 *
 * A failure to read the validator set denies the sender, loudly: it is an
 * unknown, not an answer, and it must not read as "nobody is a validator".
 */
export async function isMergePeerEligible(sender: string): Promise<boolean> {
    if (!sender) return false
    const id = sender.toLowerCase()
    const head = getSharedState.lastBlockNumber ?? 0

    const staked = await getStakedSet()
    if (staked.has(id)) return true

    if (staked.size === 0) {
        // The cached set is also empty after a failed refresh, so ask the
        // database directly to tell "no validators" from "could not read".
        let activeCount: number
        try {
            activeCount = (await GCR.getGCRValidatorsAtBlock(head)).length
        } catch (e) {
            log.error(
                `[mergeEligibility] cannot read the validator set at block ${head} (${describe(e)}); ` +
                    `denying mempool merge from ${sender} as unknown`,
            )
            return false
        }
        if (
            activeCount === 0 &&
            process.env.DEMOS_REQUIRE_VALIDATORS !== "true"
        ) {
            return (
                id === getSharedState.publicKeyHex?.toLowerCase() ||
                PeerManager.getInstance().getPeer(sender) !== undefined
            )
        }
    }

    try {
        const pool = await getEligiblePool(head)
        return pool.some(member => member.toLowerCase() === id)
    } catch (e) {
        log.error(
            `[mergeEligibility] cannot resolve the eligible pool at block ${head} (${describe(e)}); ` +
                `denying mempool merge from ${sender}`,
        )
        return false
    }
}
