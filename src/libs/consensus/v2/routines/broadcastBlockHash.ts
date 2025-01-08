import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { ConsensusHashResponse } from "../interfaces"
import Block from "src/libs/blockchain/block"
import { Peer } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

export async function broadcastBlockHash(
    block: Block,
    shard: Peer[],
): Promise<[number, number]> {
    var pro = 0
    var con = 0
    // var promises = []

    const ourId = getSharedState.identity.ed25519.publicKey.toString("hex")
    const proposeParams = [block.hash, block.validation_data, ourId]

    let promises: Map<string, Promise<RPCResponse>> = new Map()

    for (const peer of shard) {
        promises.set(
            peer.identity,
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
    for (const [identity, promise] of promises) {
        // Work asynchronously
        promise.then((response: RPCResponse) => {
            log.info("[broadcastBlockHash] response from a validator received.")
            if (response.result === 200) {
                let peerId = response.response
                let peerValidationData = response.extra.signatures[peerId]

                log.info(
                    "[broadcastBlockHash] Block hash confirmation received from the validator: " +
                        peerId,
                )
                // Add the validation data to the block
                // ? Should we check if the peer is in the shard? Theoretically we checked before
                log.info(
                    "[broadcastBlockHash] Peer validation data: ",
                    peerValidationData,
                )
                block.validation_data.signatures[response.response] =
                    peerValidationData
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
    const validationDataCount = Object.keys(
        block.validation_data.signatures,
    ).length
    return [validationDataCount, shard.length - validationDataCount]
}
