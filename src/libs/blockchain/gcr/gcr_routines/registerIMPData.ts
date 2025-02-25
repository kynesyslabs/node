// INFO To safely transition from L2 (IMP) to L1 (DEMOS) it is necessary to have a wrapper that interprets the results
import { Hash } from "crypto"
// The outcome of this method can be feed to GCR.addToGCRIMPData
import { ImMessage } from "src/features/InstantMessagingProtocol/types/IMSession"
import Cryptography from "src/libs/crypto/cryptography"
import { forgeToHex, hexToForge } from "src/libs/crypto/forgeUtils"
import Hashing from "src/libs/crypto/hashing"

export default async function registerIMPData(
    bundle: ImMessage[],
): Promise<[boolean, any]> {
    const status = false
    const message = "Error while registering IMP data"
    // REVIEW Verify each message
    for (let i = 0; i < bundle.length; i++) {
        const message = bundle[i]
        const {
            message: { data, timestamp, isEncrypted, from },
            signature,
        } = message
        // Verify the signature
        const hash = Hashing.sha256(JSON.stringify(message.message))
        const verified = Cryptography.verify(
            hash,
            signature,
            message.message.from,
        )
        console.log(
            "[IMPRegistering] Invalid signature for message: " +
                JSON.stringify(message),
        )
        if (!verified) {
            return [status, "Invalid signature"]
        }
    }
    // TODO Derive a final value (or create an hash or anything similar depending on data)
    // TODO Write the value to the GCR
    return [status, message]
}
