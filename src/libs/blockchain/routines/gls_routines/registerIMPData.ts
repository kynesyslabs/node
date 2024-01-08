// INFO To safely transition from L2 (IMP) to L1 (DEMOS) it is necessary to have a wrapper that interprets the results
// The outcome of this method can be feed to GLS.addToGLSIMPData
import { IMMessage } from "src/features/InstantMessagingProtocol/types/IMSession";
import Cryptography from "src/libs/crypto/cryptography";
import Hashing from "src/libs/crypto/hashing";
import { ForgeToHex, HexToForge } from "src/libs/crypto/forgeUtils";
import { Hash } from "crypto";

export default async function registerIMPData(bundle: IMMessage[]): Promise<[boolean, any]> {
    let status = false;
    let message = "Error while registering IMP data";
    // REVIEW Verify each message
    for (let i = 0; i < bundle.length; i++) {
        let message = bundle[i];
        let { message: { data, timestamp, isEncrypted, from }, signature } = message;
        // Verify the signature
        let hash = Hashing.sha256(JSON.stringify(message.message))
        let verified = Cryptography.verify(hash, signature, message.message.from)
        console.log("[IMPRegistering] Invalid signature for message: " +  JSON.stringify(message))
        if (!verified) {
            return [status, "Invalid signature"];
        }
    }
    // TODO Derive a final value (or create an hash or anything similar depending on data)
    // TODO Write the value to the GLS
    return [status, message];
}