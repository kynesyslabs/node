import getShard from "./getShard"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import { getSharedState } from "@/utilities/sharedState"

// Single function - reuses existing logic
export default async function isValidatorForNextBlock(): Promise<boolean> {
    try {
        const { commonValidatorSeed } = await getCommonValidatorSeed()
        const validators = await getShard(commonValidatorSeed)
        const ourIdentity = getSharedState.identity.ed25519.publicKey.toString("hex")
        return validators.some(peer => peer.identity === ourIdentity)
    } catch {
        return false // Conservative fallback
    }
}