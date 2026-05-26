import getShard from "./getShard"
import { Peer } from "@/libs/peer"
import { getSharedState } from "@/utilities/sharedState"
import getCommonValidatorSeed from "./getCommonValidatorSeed"

/**
 * Determines whether the local node is included in the validator shard for the next block.
 *
 * @returns An object containing:
 * - `isValidator`: `true` if the local node's public key is present among the shard validators, `false` otherwise.
 * - `validators`: the array of `Peer` objects representing the validators for the computed shard.
 */
export default async function isValidatorForNextBlock(): Promise<{
    isValidator: boolean
    validators: Peer[]
    lastBlockHash: string
}> {
    const { commonValidatorSeed } = await getCommonValidatorSeed()
    const validators = await getShard(commonValidatorSeed)

    return {
        isValidator: validators.some(
            peer => peer.identity === getSharedState.publicKeyHex,
        ),
        validators,
        lastBlockHash: getSharedState.lastBlockHash,
    }
}
