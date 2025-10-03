import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { ConsensusHashResponse } from "../interfaces"
import Block from "src/libs/blockchain/block"
import { Peer } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"

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
            peer.longCall({
                method: "consensus_routine",
                params: [
                    {
                        method: "proposeBlockHash",
                        params: proposeParams,
                    },
                ],
            }), // REVIEW  We should wait a little if the call returns false as the node is not in the consensus loop yet and in general for all consensus_routine calls
        )
    }
    // See manageConsensusRoutine.ts for more details on the response format and mechanism
    for (const promise of promises) {
        // Work asynchronously
        promise.then(async (response: RPCResponse) => {
            log.info("[broadcastBlockHash] response from a validator received.")
            if (response.result === 200) {
                log.info(
                    "[broadcastBlockHash] Block hash confirmation received from the validator: " +
                        response.response,
                )
                log.debug(
                    "[broadcastBlockHash] response: " +
                        JSON.stringify(response, null, 2),
                )
                // Add the validation data to the block
                // ? Should we check if the peer is in the shard? Theoretically we checked before
                const peerValidationData =
                    response.extra.signatures[response.response]
                log.info(
                    "[broadcastBlockHash] Peer validation data: ",
                    peerValidationData,
                )
                block.validation_data.signatures[response.response] =
                    peerValidationData

                const incomingSignatures: { [key: string]: string } =
                    response.extra["signatures"]

                const signatureVerificationPromises = Object.entries(
                    incomingSignatures,
                ).map(async ([identity, signature]) => {
                    const isValid = await ucrypto.verify({
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
                        "Found invalid incoming signature by: " + identity,
                    )
                    log.error("Proposed signature: " + signature)
                    log.error("Candidate block hash: " + block.hash)
                    log.error(
                        "Signature verification failed. Signature not added.",
                    )
                    return { identity, signature, isValid: false }
                })

                await Promise.all(signatureVerificationPromises)
                pro++
            } else {
                log.error(
                    "[broadcastBlockHash] Block hash not confirmed from the validator: " +
                        response.response,
                )
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
                    "[broadcastBlockHash] Response received: " +
                        JSON.stringify(response.extra, null, 2),
                )
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
