// TODO Implement the identity manager
import { abstraction } from "@kynesyslabs/demosdk"

/**
 * Example of a payload for the gcr_routine method
 * payload = {
 *     method: "gcr_routine",
 *     params: [
 *         {
 *             method: "identity_assign_from_write|identity_assign_from_signature",
 *             params: [the appropriate payload]
 *         }
 *     ],
 * }
 */

export default class IdentityManager {
    constructor() {}

    // Infer identity from a valid write transaction
    static async inferIdentityFromWrite(
        payload: abstraction.InferFromWritePayload,
    ): Promise<string | false> {
        // TODO Implement: check if the transaction is valid and assign the identity to the target address
        return false
    }

    // Infer identity from a valid signature
    static async inferIdentityFromSignature(
        payload: abstraction.InferFromSignaturePayload,
    ): Promise<string | false> {
        // TODO Implement: check if the signature is valid and assign the identity to the target address
        return false
    }
}
