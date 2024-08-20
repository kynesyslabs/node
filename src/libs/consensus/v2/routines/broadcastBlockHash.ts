import { ConsensusHashResponse } from "../interfaces"
import Block from "src/libs/blockchain/block"
import { Peer } from "src/libs/peer"

export async function broadcastBlockHash(block: Block, shard: Peer[]): Promise<[number, number]> {
    var pro = 0
    var con = 0
    var promises = []
    for (const peer of shard) {
        promises.push(
            peer.call({
                method: "proposeBlockHash", // ! We should create the necessary RPCs endpoints for this
                params: [block.hash, block.validation_data],
            }),
        )
    }
    // ! The endpoints should reply with a boolean and their own validation data
    for (const promise of promises) {
        // Work asynchronously
        promise.then((response: ConsensusHashResponse) => {
            console.log("[consensusRoutine] response from a validator: ", response)
            if (response.success) {
                console.log(
                    "[consensusRoutine] Block hash confirmation received from the validator: " +
                        response.validation_data[0],
                )
                // Add the validation data to the block
                block.validation_data.signatures[response.validation_data[0]] =
                    response.validation_data[1]
                pro++
            } else {
                console.log("[consensusRoutine] Block hash not confirmed from the validator: " + response.validation_data[0])
                console.log("[consensusRoutine] Block hash proposed: ", block.hash)
                console.log("[consensusRoutine] Block hash received: ", response.hash)
                con++
            }
        })
    }
    await Promise.all(promises)
    return [pro, con]
}