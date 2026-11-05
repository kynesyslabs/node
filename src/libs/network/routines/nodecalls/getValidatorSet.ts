import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import {
    validatorSetAt,
    validatorSetHash,
} from "src/libs/blockchain/finality/validatorSet"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { answer, failedRead, refusal, toBlockNumber } from "./finalityShared"

/**
 * The validator set after block `blockNumber`, V(b): the preimage of the
 * `validator_set_hash` block b + 1 commits, which names who may sign block
 * b + 2. A client following the chain asks for it whenever that hash
 * changes, and checks sha256(jcs(validators)) against the signed block
 * itself rather than trusting `setHash`.
 *
 * `effectiveFrom` is the block the snapshot was recorded at: snapshots are
 * written only when the set changes, so one covers every height up to the
 * next.
 *
 * 404 not_found above this node's head (503 node_not_synced while it is
 * behind); 410 history_unavailable when this node holds no snapshot that
 * old; 500 lookup_failed when the stored set no longer hashes to its
 * recorded hash.
 */
export default async function getValidatorSet(data: {
    blockNumber?: unknown
}): Promise<RPCResponse> {
    const blockNumber = toBlockNumber(data?.blockNumber)
    if (blockNumber === null) {
        return refusal(400, "invalid_block_number")
    }

    try {
        const head = await Chain.getLastBlockNumber()
        if (blockNumber > head) {
            return getSharedState.syncStatus
                ? refusal(404, "not_found", { head })
                : refusal(503, "node_not_synced", { head })
        }
        const snapshot = await validatorSetAt(blockNumber)
        if (!snapshot) {
            return refusal(410, "history_unavailable", { blockNumber })
        }
        const setHash = validatorSetHash(snapshot.validators)
        if (setHash !== snapshot.setHash) {
            throw new Error(
                `validator set snapshot at block ${snapshot.block} hashes to ${setHash}, recorded as ${snapshot.setHash}`,
            )
        }
        return answer({
            blockNumber,
            effectiveFrom: snapshot.block,
            setHash,
            validators: snapshot.validators,
        })
    } catch (error) {
        log.error("[getValidatorSet] Error reading the validator set:", error)
        return failedRead(error)
    }
}
