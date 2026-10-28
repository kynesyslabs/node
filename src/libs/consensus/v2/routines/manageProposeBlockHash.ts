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
import { getBoundCommittee, getEligiblePool } from "./getShard"
import { isNetworkAhead } from "./networkAheadVeto"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import Chain from "@/libs/blockchain/chain"
import { checkTimestampAgainstParent } from "@/libs/blockchain/validation/verifyBlock"
import { isForkActive } from "@/forks/forkGates"

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

async function mergeIncomingSignatures(
    incomingSignatures: Record<string, string>,
    poolIdentities: Set<string>,
    signerSet: string,
): Promise<void> {
    const candidateBlock = getSharedState.candidateBlock
    for (const [identity, signature] of Object.entries(incomingSignatures)) {
        // verifyBlock ignores signers outside the pool, so keeping them
        // would only bloat the block and cost a verification.
        if (!poolIdentities.has(identity)) {
            log.error(
                `[manageProposeBlockHash] Dropping signature by ${identity}: not in the ${signerSet}`,
            )
            continue
        }

        let isValid = false
        try {
            isValid = await TxValidatorPool.getInstance().verify({
                algorithm: getSharedState.signingAlgorithm,
                message: new TextEncoder().encode(candidateBlock.hash),
                signature: hexToUint8Array(signature),
                publicKey: hexToUint8Array(identity),
            })
        } catch (e) {
            log.error(
                `[manageProposeBlockHash] Signature verification failed for ${identity}: ${errorMessage(e)}`,
            )
            continue
        }

        if (isValid) {
            candidateBlock.validation_data.signatures[identity] = signature
            log.debug(
                `Signature ${signature} from ${identity} added to the candidate block`,
            )
            continue
        }

        log.error(`Found invalid incoming signature by: ${identity}`)
        log.error(`Proposed signature: ${signature}`)
        log.error("Candidate block hash: " + candidateBlock.hash)
        log.error("Signature verification failed. Signature not added.")
    }
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

/**
 * The proposer's hash matches our candidate: admit its signatures into the
 * candidate and answer with the merged validation data, or refuse.
 */
async function mergeSignaturesForCandidate(
    response: RPCResponse,
    validationData: ValidationData,
    peerId: string,
    candidate: typeof getSharedState.candidateBlock,
): Promise<RPCResponse> {
    // Signatures are judged the way verifyBlock judges them: against the
    // eligible pool of the parent height, not against our own view of the
    // shard, which may differ from the proposer's. Under committeeBinding,
    // against the bound committee of the parent height.
    const incomingSignatures = getIncomingSignatures(validationData)
    const bound = isForkActive("committeeBinding", candidate.number)
    let pool: string[]
    try {
        pool = bound
            ? await getBoundCommittee(candidate.number - 1)
            : await getEligiblePool(candidate.number - 1)
    } catch (e) {
        log.error(
            `[manageProposeBlockHash] Could not resolve the ${bound ? "bound committee" : "eligible pool"}: ${errorMessage(e)}`,
        )
        response.result = 500
        response.response = getSharedState.publicKeyHex
        response.extra = bound
            ? "Could not resolve the bound committee"
            : "Could not resolve the eligible signer pool"
        return response
    }

    if (bound && !pool.includes(peerId)) {
        log.error(
            `[manageProposeBlockHash] Proposer ${peerId} is not in the bound committee: refusing the block hash`,
        )
        response.result = 401
        response.response = getSharedState.publicKeyHex
        response.extra = "Validator is not in the bound committee"
        return response
    }

    // Honest nodes draw different committees, so the map accumulated over
    // several relays can hold more signers than shardSize. Every signer
    // must be a distinct pool member, which makes the pool the ceiling.
    // Under committeeBinding every honest selection is a subset of one
    // committee, which makes the committee the ceiling.
    if (Object.keys(incomingSignatures).length > pool.length) {
        const scope = bound ? "bound committee" : "eligible pool"
        log.error(
            `[manageProposeBlockHash] Signature map larger than the ${scope}: refusing the block hash`,
        )
        response.result = 400
        response.response = getSharedState.publicKeyHex
        response.extra = `Signature map is larger than the ${scope}`
        return response
    }

    await mergeIncomingSignatures(
        incomingSignatures,
        new Set(pool),
        bound ? "bound committee" : "eligible pool",
    )

    response.extra = getSharedState.candidateBlock.validation_data
    return response
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

        return await mergeSignaturesForCandidate(
            response,
            validationData,
            peerId,
            candidate,
        )
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
