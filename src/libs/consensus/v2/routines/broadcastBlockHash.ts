import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { ConsensusHashResponse } from "../interfaces"
import Block from "src/libs/blockchain/block"
import { Peer } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"

export async function broadcastBlockHash(
    block: Block,
    shard: Peer[],
): Promise<[number, number]> {
    let pro = 0
    let con = 0
    const promises = []
    const ourId = getSharedState.publicKeyHex
    const proposeParams = [block.hash, block.validation_data, ourId]
    for (const peer of shard) {
        promises.push(
            peer.longCall(
                {
                    method: "consensus_routine",
                    params: [
                        {
                            method: "proposeBlockHash",
                            params: proposeParams,
                        },
                    ],
                },
                true,
                {
                    allowedCodes: [401],
                },
            ), // REVIEW  We should wait a little if the call returns false as the node is not in the consensus loop yet and in general for all consensus_routine calls
        )
    }

    // See manageConsensusRoutine.ts for more details on the response format and mechanism
    for (const promise of promises) {
        // Work asynchronously
        promise.then(async (response: RPCResponse) => {
            if (response.result === 200) {
                // Add the validation data to the block
                // ? Should we check if the peer is in the shard? Theoretically we checked before
                const peerValidationData =
                    response.extra.signatures[response.response]
                block.validation_data.signatures[response.response] =
                    peerValidationData

                const incomingSignatures: { [key: string]: string } =
                    response.extra["signatures"]

                const signatureVerificationPromises = Object.entries(
                    incomingSignatures,
                ).map(async ([identity, signature]) => {
                    const isValid = await TxValidatorPool.getInstance().verify({
                        algorithm: getSharedState.signingAlgorithm,
                        message: new TextEncoder().encode(block.hash),
                        signature: hexToUint8Array(signature),
                        publicKey: hexToUint8Array(identity),
                    })

                    if (isValid) {
                        block.validation_data.signatures[identity] = signature
                        log.debug(
                            `Signature ${signature} from ${identity} added to the candidate block`,
                        )
                        return { identity, signature, isValid: true }
                    }

                    log.error(
                        `Found invalid incoming signature by: ${identity}`,
                    )
                    log.error(`Proposed signature: ${signature}`)
                    log.error("Candidate block hash: " + block.hash)
                    log.error(
                        "Signature verification failed. Signature not added.",
                    )
                    return { identity, signature, isValid: false }
                })

                await Promise.all(signatureVerificationPromises)
                pro++
            } else {
                log.error("Failed for validator: " + response.response)
                log.error(
                    "[broadcastBlockHash] Block hash not confirmed from the validator: " +
                        response.response,
                )
                log.error("Message: " + response.extra.message)
                // ! We have:
                /* [WARNING] [2024-08-27T21:31:41.139Z] [RPC Call] [consensus_routine] [2024-08-27T21:31:41.100Z] Response not OK: Consensus mode is not active - 400
                [broadcastBlockHash] response from a validator received.
                [broadcastBlockHash] Block hash not confirmed from the validator: Consensus mode is not active
                // ! With the timestamp being 41 on the second node running and 37 on the first (the time interval taken to run the second node is indeed 3 seconds)
                */
                log.error(
                    "[broadcastBlockHash] Block hash proposed: " + block.hash,
                )
                log.error(
                    "[broadcastBlockHash] Response received (with error): " +
                        JSON.stringify(response.extra),
                )

                if (response.extra.ourBlock) {
                    const theirTxHashes: string[] =
                        response.extra.ourBlock.txHashes ??
                        response.extra.ourBlock.ordered_transactions ??
                        []
                    const ourTxHashes: string[] =
                        getSharedState.candidateBlock.content
                            .ordered_transactions

                    const theirSet = new Set(theirTxHashes)
                    const ourSet = new Set(ourTxHashes)

                    const missingFromUs = theirTxHashes.filter(
                        h => !ourSet.has(h),
                    )
                    const missingFromThem = ourTxHashes.filter(
                        h => !theirSet.has(h),
                    )

                    log.error(
                        "Their block: " +
                            JSON.stringify(response.extra.ourBlock, null, 2),
                    )
                    log.error(
                        "Our block: " +
                            JSON.stringify(
                                {
                                    hash: getSharedState.candidateBlock.hash,
                                    number: getSharedState.candidateBlock
                                        .number,
                                    timestamp:
                                        getSharedState.candidateBlock.content
                                            .timestamp,
                                    txCount: ourTxHashes.length,
                                    txHashes: ourTxHashes,
                                },
                                null,
                                2,
                            ),
                    )
                    log.error(
                        `[broadcastBlockHash] Missing from us (${missingFromUs.length}): ${JSON.stringify(missingFromUs)}`,
                    )
                    log.error(
                        `[broadcastBlockHash] Missing from them (${missingFromThem.length}): ${JSON.stringify(missingFromThem)}`,
                    )
                }
                con++
            }
        })
    }

    // TODO: Transmit received votes to the other nodes
    // to help with failures
    await Promise.all(promises)
    log.info(
        "[broadcastBlockHash] Block hash broadcasted to the shard: votes: " +
            pro +
            " rejections: " +
            con,
    )
    // return [pro, con]

    const signatureCount = Object.keys(
        getSharedState.candidateBlock.validation_data.signatures,
    ).length
    // INFO: Return the candidate block signature count
    return [signatureCount, shard.length - signatureCount]
}
