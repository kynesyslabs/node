import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import { isForkActive } from "@/forks/forkGates"
import {
    FINALITY_FORK,
    blockResultLeaves,
} from "src/libs/blockchain/finality/commitments"
import { auditPath, root, toHex } from "src/libs/crypto/merkle/rfc6962"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import {
    answer,
    blockBytes,
    failedRead,
    refusal,
    signedHeader,
    transactionBytes,
} from "./finalityShared"

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/

/**
 * Proof of a transaction's outcome. Blocks are forged before they execute,
 * so the result of a transaction in block m is committed by block m + 1 as
 * `parent_results_root`: the answer is the result leaf, its RFC 6962 audit
 * path, block m (whose signed `ordered_transactions` fixes the tree size and
 * whose committed peerlist and validator set name who may sign m + 1) and
 * block m + 1 with its certificate.
 *
 * `tx` is the transaction itself: the bytes its hash is the sha256 of and
 * its signature, so a client checks from, to, amount and nonce against what
 * the block orders without a second read.
 *
 * 404 not_found for a hash this node does not hold (503 node_not_synced
 * while it is behind, as getTransactionStatus); 404 no_result_commitment
 * when block m + 1 is outside finalityProofs or m is genesis; 409
 * not_yet_committed until block m + 1 exists; 500 content_unrecoverable when
 * a block's or the transaction's stored content no longer hashes to its
 * hash, and 500 lookup_failed when this node's rows do not rebuild the
 * committed root.
 */
export default async function getTransactionProof(data: {
    hash?: unknown
}): Promise<RPCResponse> {
    const hash = data?.hash
    if (typeof hash !== "string" || !TX_HASH_REGEX.test(hash)) {
        return refusal(400, "invalid_hash")
    }
    const txHash = hash.toLowerCase()

    try {
        const tx = await Chain.getTxByHash(txHash)
        if (!tx) {
            return getSharedState.syncStatus
                ? refusal(404, "not_found")
                : refusal(503, "node_not_synced")
        }
        const m = Number(tx.blockNumber)
        if (!Number.isSafeInteger(m) || m < 0) {
            throw new Error(`tx ${txHash} is stored without a block number`)
        }
        if (m < 1 || !isForkActive(FINALITY_FORK, m + 1)) {
            return refusal(404, "no_result_commitment", { blockNumber: m })
        }

        const [inclusion, commit] = await Promise.all([
            Chain.getBlockByNumber(m),
            Chain.getBlockByNumber(m + 1),
        ])
        if (!inclusion) {
            throw new Error(`block ${m} of tx ${txHash} is not stored`)
        }
        if (!commit) {
            return refusal(409, "not_yet_committed", { blockNumber: m, committedIn: null })
        }

        const ordered = inclusion.content?.ordered_transactions ?? []
        const leafIndex = ordered.indexOf(txHash)
        if (leafIndex < 0) {
            throw new Error(`tx ${txHash} is not in the ordered transactions of block ${m}`)
        }
        const leaves = await blockResultLeaves(inclusion)
        const committedRoot = (commit.content as { parent_results_root?: unknown })
            .parent_results_root
        if (toHex(root(leaves)) !== committedRoot) {
            throw new Error(
                `the stored results of block ${m} do not rebuild the parent_results_root of block ${m + 1}`,
            )
        }

        const txBytes = transactionBytes(tx, m)

        return answer({
            hash: txHash,
            blockNumber: m,
            leafIndex,
            treeSize: ordered.length,
            leaf: new TextDecoder().decode(leaves[leafIndex]),
            auditPath: auditPath(leaves, leafIndex).map(toHex),
            committedIn: m + 1,
            inclusionBlock: blockBytes(inclusion),
            commitBlock: signedHeader(commit),
            tx: txBytes,
        })
    } catch (error) {
        log.error("[getTransactionProof] Error building the proof:", error)
        return failedRead(error)
    }
}
