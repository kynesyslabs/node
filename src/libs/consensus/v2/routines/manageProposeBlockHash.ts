import { ValidationData } from "../interfaces"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { emptyResponse } from "src/libs/network/server_rpc"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import ensureCandidateBlockFormed from "./ensureCandidateBlockFormed"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import PeerManager from "@/libs/peer/PeerManager"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import getShard from "./getShard"
import { getSecretaryIdentity } from "@/libs/consensus/petri/coordination/petriSecretary"

export default async function manageProposeBlockHash(
    blockHash: string,
    validationData: ValidationData,
    peerId: string,
    sender?: string,
): Promise<RPCResponse> {
    const response = _.cloneDeep(emptyResponse)
    log.info("[Consensus Message Received] Propose Block Hash")
    log.info(`Block Hash: ${blockHash}`)
    log.debug(`Validation Data: ${JSON.stringify(validationData)}`)
    log.info(`Peer ID: ${peerId}`)
    // Checking if the validator that sent us the block hash is in the shard
    // const shard = getSharedState.lastShard
    const { commonValidatorSeed } = await getCommonValidatorSeed()
    const shard = await getShard(commonValidatorSeed)

    const validator = shard.find(validator => validator.identity === peerId)
    const peer = PeerManager.getInstance().getPeer(peerId)
    if (!validator) {
        log.error(
            "[manageProposeBlockHash] Validator (" +
                peer.connection.string +
                ") is not in the shard: refusing the block hash",
        )
        response.result = 401
        response.response = getSharedState.publicKeyHex
        response.extra = "Validator is not in the shard"
        return response
    }
    log.info(
        "[manageProposeBlockHash] Validator is in the shard: voting for the block hash",
    )

    // REVIEW: Petri Consensus — verify-then-sign (secretary model)
    // In Petri, every shard member compiles the block deterministically
    // (PetriBlockCompiler) and only the elected secretary broadcasts its hash.
    // We refuse proposals that do not come from the secretary (or whose claimed
    // proposer differs from the authenticated sender) and then fall through to
    // the candidate comparison below, so we only ever sign a hash that matches
    // the block we compiled ourselves.
    if (getSharedState.petriConsensus) {
        if (sender && sender !== peerId) {
            log.error(
                `[manageProposeBlockHash] Petri: claimed proposer ${peerId} ` +
                    `does not match authenticated sender ${sender}: refusing the block hash`,
            )
            response.result = 401
            response.response = getSharedState.publicKeyHex
            response.extra = "Proposer does not match authenticated sender"
            return response
        }

        const secretaryId = getSecretaryIdentity(shard)
        if (peerId !== secretaryId) {
            log.error(
                `[manageProposeBlockHash] Petri: proposer ${peerId} is not the ` +
                    `elected secretary (${secretaryId}): refusing the block hash`,
            )
            response.result = 401
            response.response = getSharedState.publicKeyHex
            response.extra = "Proposer is not the elected secretary"
            return response
        }

        log.info(
            "[manageProposeBlockHash] Petri: proposer is the secretary — verifying against our candidate block",
        )
    }

    // Compare with our own candidate block (PoRBFT v2 and Petri)
    // ? Should we check for the block number as well? Or we cancel the candidateBlock at the end of the consensus?
    // Vote for the block hash
    // We must ensure we generated a block indeed
    const candidateBlockFormed = await ensureCandidateBlockFormed()
    log.debug(
        "[manageProposeBlockHash] Candidate block formed: " +
            JSON.stringify(candidateBlockFormed),
    )
    if (!candidateBlockFormed) {
        log.error(
            "[manageProposeBlockHash] Candidate block not formed: refusing the block hash",
        )

        response.result = 401
        response.response = getSharedState.publicKeyHex
        response.extra = "Candidate block not formed"
        return response
    }
    const ourCandidateHash = getSharedState.candidateBlock.hash
    if (ourCandidateHash === blockHash) {
        log.info(
            "[manageProposeBlockHash] Hash corresponds to our candidate block",
        )
        response.result = 200
        response.response = getSharedState.publicKeyHex

        // INFO: Copy the incoming signatures to our candidate block
        for (const [identity, signature] of Object.entries(
            validationData["signatures"],
        )) {
            let isValid = false

            try {
                isValid = await ucrypto.verify({
                    algorithm: getSharedState.signingAlgorithm,
                    message: new TextEncoder().encode(
                        getSharedState.candidateBlock.hash,
                    ),
                    signature: hexToUint8Array(signature),
                    publicKey: hexToUint8Array(identity),
                })
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e)
                log.error(`[manageProposeBlockHash] Signature verification failed for ${identity}: ${errorMsg}`)
                continue
            }

            if (isValid) {
                getSharedState.candidateBlock.validation_data.signatures[
                    identity
                ] = signature
                log.debug(
                    `Signature ${signature} from ${identity} added to the candidate block`,
                )
                continue
            }

            log.error(`Found invalid incoming signature by: ${identity}`)
            log.error(`Proposed signature: ${signature}`)
            log.error(
                "Candidate block hash: " + getSharedState.candidateBlock.hash,
            )
            log.error("Signature verification failed. Signature not added.")
        }

        response.extra = getSharedState.candidateBlock.validation_data
        return response
    }

    log.info(
        "[manageProposeBlockHash] Hash does not correspond to our candidate block",
    )
    response.result = 401
    response.response = getSharedState.publicKeyHex
    response.extra = "Hash does not correspond to our candidate block"
    return response
}
