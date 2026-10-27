import { ValidationData } from "../interfaces"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { emptyResponse } from "src/libs/network/server_rpc"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import ensureCandidateBlockFormed from "./ensureCandidateBlockFormed"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import PeerManager from "@/libs/peer/PeerManager"
import getRoundCommittee from "./roundCommittee"
import { isNetworkAhead } from "./networkAheadVeto"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import Chain from "@/libs/blockchain/chain"
import { checkTimestampAgainstParent } from "@/libs/blockchain/validation/verifyBlock"

function getIncomingSignatures(
    validationData: ValidationData,
): Record<string, string> {
    const signatures = validationData?.signatures as unknown
    if (
        signatures === null ||
        typeof signatures !== "object" ||
        Array.isArray(signatures)
    ) {
        return {}
    }
    return signatures as Record<string, string>
}

export default async function manageProposeBlockHash(
    blockHash: string,
    validationData: ValidationData,
    peerId: string,
): Promise<RPCResponse> {
    log.debug("Received manageProposeBlockHash, block hash: " + blockHash)
    const response = _.cloneDeep(emptyResponse)

    if (await isNetworkAhead("proposeBlockHash")) {
        response.result = 400
        response.response = getSharedState.publicKeyHex
        response.extra = "Node is behind the network, syncing"
        return response
    }

    // Checking if the validator that sent us the block hash is in the shard
    const { members: shard, frozen } = await getRoundCommittee()
    log.debug(
        `Shard (${frozen ? "frozen" : "drawn"}): ` +
            JSON.stringify(shard.map(s => s.connection.string), null, 2),
    )

    const validator = shard.find(validator => validator.identity === peerId)
    const peer = PeerManager.getInstance().getPeer(peerId)
    if (!validator) {
        log.error(
            "[manageProposeBlockHash] Validator (" +
                (peer?.connection?.string ?? peerId) +
                ") is not in the shard: refusing the block hash",
        )
        response.result = 401
        response.response = getSharedState.publicKeyHex
        response.extra = "Validator is not in the shard"
        return response
    }

    // A legitimate proposer relays at most one signature per shard member.
    const incomingSignatures = getIncomingSignatures(validationData)
    if (Object.keys(incomingSignatures).length > shard.length) {
        log.error(
            "[manageProposeBlockHash] Signature map larger than the shard: refusing the block hash",
        )
        response.result = 400
        response.response = getSharedState.publicKeyHex
        response.extra = "Signature map is larger than the shard"
        return response
    }

    // ? Should we check for the block number as well? Or we cancel the candidateBlock at the end of the consensus?
    // Vote for the block hash
    // We must ensure we generated a block indeed
    const candidateBlockFormed = await ensureCandidateBlockFormed()
    if (!candidateBlockFormed) {
        log.error(
            "[manageProposeBlockHash] Candidate block not formed: refusing the block hash",
        )

        response.result = 404
        response.response = getSharedState.publicKeyHex
        response.extra = "Candidate block not formed"
        return response
    }

    const candidate = getSharedState.candidateBlock
    const parentBlock = await Chain.getBlockByNumber(candidate.number - 1)
    const timestampVerdict = checkTimestampAgainstParent(
        candidate.content.timestamp,
        parentBlock?.content?.timestamp,
    )
    if (!timestampVerdict.valid) {
        log.error(
            `[manageProposeBlockHash] Refusing to sign block ${candidate.number}: ${timestampVerdict.reason}`,
        )
        response.result = 409
        response.response = getSharedState.publicKeyHex
        response.extra = {
            message: "Candidate block timestamp is invalid",
            reason: timestampVerdict.reason,
        }
        return response
    }

    const ourCandidateHash = candidate.hash
    if (ourCandidateHash === blockHash) {
        log.info(
            "[manageProposeBlockHash] Hash corresponds to our candidate block",
        )
        response.result = 200
        response.response = getSharedState.publicKeyHex

        // INFO: Copy the incoming signatures to our candidate block
        const memberIdentities = new Set(shard.map(member => member.identity))
        for (const [identity, signature] of Object.entries(
            incomingSignatures,
        )) {
            // Block validity counts shard signatures only; anything else would
            // just bloat the block and cost a verification.
            if (!memberIdentities.has(identity)) {
                log.error(
                    `[manageProposeBlockHash] Dropping signature by ${identity}: not a shard member`,
                )
                continue
            }

            let isValid = false

            try {
                isValid = await TxValidatorPool.getInstance().verify({
                    algorithm: getSharedState.signingAlgorithm,
                    message: new TextEncoder().encode(
                        getSharedState.candidateBlock.hash,
                    ),
                    signature: hexToUint8Array(signature),
                    publicKey: hexToUint8Array(identity),
                })
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e)
                log.error(
                    `[manageProposeBlockHash] Signature verification failed for ${identity}: ${errorMsg}`,
                )
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

    response.result = 401
    response.response = getSharedState.publicKeyHex
    response.extra = {
        message: "Hash does not correspond to our candidate block",
        ourBlock: {
            hash: getSharedState.candidateBlock.hash,
            number: getSharedState.candidateBlock.number,
            timestamp: getSharedState.candidateBlock.content.timestamp,
            txCount:
                getSharedState.candidateBlock.content.ordered_transactions
                    .length,
            txHashes:
                getSharedState.candidateBlock.content.ordered_transactions,
        },
    }
    return response
}
