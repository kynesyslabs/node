import getShard from "./getShard"
import { Peer } from "@/libs/peer"
import { getSharedState } from "@/utilities/sharedState"
import getCommonValidatorSeed from "./getCommonValidatorSeed"

export default async function isValidatorForNextBlock(): Promise<{
    isValidator: boolean
    validators: Peer[]
}> {
    const { commonValidatorSeed } = await getCommonValidatorSeed()
    const validators = await getShard(commonValidatorSeed)

    return {
        isValidator: validators.some(
            peer => peer.identity === getSharedState.publicKeyHex,
        ),
        validators,
    }
}
