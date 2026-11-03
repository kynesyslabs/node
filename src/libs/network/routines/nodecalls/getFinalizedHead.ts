import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import { getAheadValidatorPeers } from "src/libs/consensus/v2/routines/networkAheadVeto"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

// Block timestamps are whole seconds, except a genesis built without a
// configured timestamp, which stored Date.now(). No seconds value reaches
// this before the year 33658.
const MILLISECONDS_FLOOR = 1e12

function toSeconds(value: unknown): number | null {
    const n =
        typeof value === "bigint"
            ? Number(value)
            : typeof value === "string" && /^\d+$/.test(value)
              ? Number(value)
              : value
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null
    return Math.floor(n >= MILLISECONDS_FLOOR ? n / 1000 : n)
}

/**
 * False before the first sync, while two or more blocks behind, and while a
 * validator peer credibly claims a higher block: a head that is final here
 * can still be well behind the network's. A failed check counts as behind.
 */
async function isNodeSynced(): Promise<boolean> {
    if (!getSharedState.syncStatus) return false
    try {
        return (await getAheadValidatorPeers()).length === 0
    } catch (error) {
        log.warning(
            `[getFinalizedHead] network-ahead check failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
    }
}

/**
 * The latest block this node has inserted, which is its finalized head: a
 * block is final once it carries a quorum of precommits from the committee
 * bound to its height, and nothing enters the chain without passing that
 * check.
 *
 * A node that is behind still answers 200 with `nodeSynced: false`: the head
 * it reports is final, and the age tells a client how far behind it may be.
 * 503 node_not_synced means no block at all; 500 lookup_failed means the
 * node could not read its head. The body keeps `nodeSynced` in every case,
 * because SDK clients read only the body.
 *
 * `signatures` are the block's stored validator signatures, so a client can
 * count them against the committee; genesis is final by configuration and
 * carries a single placeholder entry.
 */
export default async function getFinalizedHead(): Promise<RPCResponse> {
    try {
        const block = await Chain.getLastBlock()
        const nodeSynced = await isNodeSynced()
        if (!block) {
            return {
                result: 503,
                response: {
                    number: null,
                    hash: null,
                    timestamp: null,
                    ageSeconds: null,
                    nodeSynced: false,
                    checkedThroughBlock: null,
                    signatureCount: 0,
                    signatures: {},
                },
                extra: { reason: "node_not_synced" },
                require_reply: false,
            }
        }

        const stored = block.content?.timestamp as unknown
        const seconds = toSeconds(stored)
        const signatures = block.validation_data?.signatures ?? {}
        return {
            result: 200,
            response: {
                number: block.number,
                hash: block.hash,
                timestamp: typeof stored === "bigint" ? stored.toString() : (stored ?? null),
                ageSeconds:
                    seconds === null
                        ? null
                        : Math.max(0, Math.floor(getNetworkTimestamp() - seconds)),
                nodeSynced,
                checkedThroughBlock: block.number,
                signatureCount: Object.keys(signatures).length,
                signatures,
            },
            extra: "",
            require_reply: false,
        }
    } catch (error) {
        log.error("[getFinalizedHead] Error reading the head:", error)
        return {
            result: 500,
            response: { error: "INTERNAL_ERROR", nodeSynced: false },
            extra: {
                reason: "lookup_failed",
                error: error instanceof Error ? error.message : String(error),
            },
            require_reply: false,
        }
    }
}
