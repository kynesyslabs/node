import { ValidationData } from "../interfaces"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { emptyResponse } from "src/libs/network/server_rpc"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import ensureCandidateBlockFormed from "./ensureCandidateBlockFormed"

export default async function manageProposeBlockHash(
    blockHash: string,
    validationData: ValidationData,
    peerId: string,
): Promise<RPCResponse> {
    const response = _.cloneDeep(emptyResponse)
    log.info("[Consensus Message Received] Propose Block Hash")
    log.info("Block Hash: " + blockHash)
    log.info("Validation Data: \n" + JSON.stringify(validationData, null, 2))
    log.info("Peer ID: " + peerId)
    // Checking if the validator that sent us the block hash is in the shard
    const shard = getSharedState.lastShard
    const validator = shard.find((validator) => validator === peerId)
    if (!validator) {
        log.error("[manageProposeBlockHash] Validator is not in the shard: refusing the block hash")
        response.result = 401
        response.response = getSharedState.identity.ed25519.publicKey.toString("hex")
        response.extra = "Validator is not in the shard"
        return response
    }
    log.info("[manageProposeBlockHash] Validator is in the shard: voting for the block hash")
    // ? Should we check for the block number as well? Or we cancel the candidateBlock at the end of the consensus?
    // Vote for the block hash
    // We must ensure we generated a block indeed
    let candidateBlockFormed = await ensureCandidateBlockFormed()
    if (!candidateBlockFormed) {
        log.error("[manageProposeBlockHash] Candidate block not formed: refusing the block hash")
        response.result = 401
        response.response = getSharedState.identity.ed25519.publicKey.toString("hex")
        response.extra = "Candidate block not formed"
        return response
    }
    const ourCandidateHash = getSharedState.candidateBlock.hash
    if (ourCandidateHash === blockHash) {
        log.info("[manageProposeBlockHash] Hash corresponds to our candidate block")
        response.result = 200
        response.response = getSharedState.identity.ed25519.publicKey.toString("hex")
        response.extra = getSharedState.candidateBlock.validation_data
        return response
    }
    log.info("[manageProposeBlockHash] Hash does not correspond to our candidate block")
    response.result = 401
    response.response = getSharedState.identity.ed25519.publicKey.toString("hex")
    response.extra = "Hash does not correspond to our candidate block"
    return response
}
