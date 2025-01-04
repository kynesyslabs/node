// TODO Implement the identity manager
import { abstraction } from "@kynesyslabs/demosdk"
import { xmcore } from "@kynesyslabs/demosdk"
import Datasource from "src/model/datasource"
// TODO Remove unused imports once you finish the identity manager
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import { Validators } from "src/model/entities/Validators"
import terminalkit from "terminal-kit"
import { LessThanOrEqual } from "typeorm"
import {
    Operation,
    OperationRegistrySlot,
    OperationResult,
} from "@kynesyslabs/demosdk/types"

import Chain from "../../chain"
import executeOperations, { Actor } from "../../routines/executeOperations"
import gcrStateSave from "../gcr_routines/gcrStateSaverHelper"
import { Cryptography } from "node_modules/@kynesyslabs/demosdk/build/encryption"
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

/** TODO
 * - We should use XM (xmcore) to verify the signature based on the public key and the network
 * e.g.:
 * 
        let solana = xmcore.SOLANA.createInstance("url")
        let isValid = solana.verifyMessage("message", Uint8Array.from("signature"), Uint8Array.from("publicKey"))
 * - Once we have the identity, we should store it in the database updating the identity table
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
    ): Promise<[boolean, string]> {
        // Get and verify the demos identity from the payload
        let [isValid, demosIdentity] =
            await this.verifyDemosIdentitiesFromPayload(payload)
        if (!isValid) {
            return [false, "Demos Identity could not be verified"]
        }
        let idVerified = false
        // Check if the target chain is evm and verify the signature with xmcore
        if (payload.target_identity.isEVM) {
            let evmInstance = await xmcore.EVM.create("") // ! Add the right provider or allow to create the instance without it
            idVerified = await evmInstance.verifyMessage(
                payload.target_identity.signedData,
                payload.target_identity.signature,
                payload.target_identity.targetAddress,
            )
        } else {
            // TODO 3b. If the target chain is not evm, verify the signature through xmcore (see above) based on the public key and the network
        }
        // If valid, store the identity in the database
        if (idVerified) {
            return [false, "not implemented"] // ! Implement the identity storage in the database
        }
        // TODO 5. Based on the result, return the identity or false
        return [true, ""] // ? Better types
    }

    // SECTION Helper functions

    // Verify demos identities from payload
    static async verifyDemosIdentitiesFromPayload(
        payload:
            | abstraction.InferFromSignaturePayload
            | abstraction.InferFromWritePayload,
    ): Promise<[boolean, string]> {
        let demosIdentity = payload.demos_identity.address
        let demosIdentitySignature = payload.demos_identity.signature
        let demosIdentitySignedData = payload.demos_identity.signedData
        let isValid = Cryptography.verify(
            demosIdentitySignedData,
            demosIdentitySignature,
            demosIdentity,
        )
        if (!isValid) {
            return [false, "Demos Identity could not be verified"]
        }
        return [true, demosIdentity]
    }
}
