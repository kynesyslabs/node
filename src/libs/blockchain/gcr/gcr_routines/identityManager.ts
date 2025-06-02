// TODO Implement the identity manager
import {
    InferFromWritePayload,
    InferFromSignatureTargetIdentityPayload,
    InferFromSignaturePayload,
} from "@kynesyslabs/demosdk/abstraction"
import {
    EVM,
    IBC,
    MULTIVERSX,
    NEAR,
    SOLANA,
    TON,
    XRPL,
    BTC,
} from "@kynesyslabs/demosdk/xm-localsdk"

import { DefaultChain } from "node_modules/@kynesyslabs/demosdk/build/multichain/core"
import ensureGCRForUser from "./ensureGCRForUser"
import log from "src/utilities/logger"
// TODO: refactor import to use high level abstraction module
import { PqcIdentityAssignPayload } from "node_modules/@kynesyslabs/demosdk/build/types/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"

/*
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

const chains: { [key: string]: typeof DefaultChain } = {
    solana: SOLANA,
    evm: EVM,
    egld: MULTIVERSX,
    ton: TON,
    xrpl: XRPL,
    ibc: IBC,
    near: NEAR,
    // @ts-expect-error - BTC module contains more fields than the DefaultChain type
    btc: BTC,
}

export default class IdentityManager {
    constructor() {}

    // Infer identity from a valid write transaction
    static async inferIdentityFromWrite(
        payload: InferFromWritePayload,
    ): Promise<string | false> {
        // TODO Implement: check if the transaction is valid and assign the identity to the target address
        return false
    }

    /**
     * Verify the xm identity payload signature
     *
     * @param payload - The payload containing the signature to verify
     * @param senderEd25519 - The ed25519 address of the sender (signed message)
     *
     * @returns {success: boolean, message: string}
     */
    static async verifyPayload(
        payload: InferFromSignaturePayload,
        senderEd25519: string,
    ): Promise<{ success: boolean; message: string }> {
        log.debug("Verifying payload: " + JSON.stringify(payload, null, 2))
        const chainId = payload.target_identity.chain
        // @ts-expect-error - This is a workaround to avoid type errors
        const sdk = await chains[chainId].create(null)

        const signedData = senderEd25519
        const { signature, publicKey, targetAddress } =
            payload.target_identity as unknown as InferFromSignatureTargetIdentityPayload

        let messageVerified = false
        try {
            if (
                chainId === "xrpl" ||
                chainId === "ton" ||
                chainId === "ibc" ||
                chainId === "near"
            ) {
                messageVerified = await sdk.verifyMessage(
                    signedData,
                    signature,
                    publicKey,
                )
            } else {
                messageVerified = await sdk.verifyMessage(
                    signedData,
                    signature,
                    targetAddress,
                )
            }

            if (!messageVerified) {
                return {
                    success: false,
                    message: "Message could not be verified",
                }
            }

            return {
                success: true,
                message: "Message verified",
            }
        } catch (error) {
            log.error("Error: " + error)
            return {
                success: false,
                message: error.toString(),
            }
        }
    }

    /**
     * Verify the payload signature for a pqc identity assign payload
     *
     * @param payloads - An array of payloads to verify
     * @param message - The message to verify. Should be the same for all payloads (the ed25519 public key of the sender)
     *
     * @returns {success: boolean, message: string}
     */
    static async verifyPqcPayload(
        payloads: PqcIdentityAssignPayload["payload"],
        senderEd25519: string,
    ): Promise<{ success: boolean; message: string }> {
        for (const payload of payloads) {
            const verified = await ucrypto.verify({
                algorithm: "ed25519",
                signature: hexToUint8Array(payload.signature),
                publicKey: hexToUint8Array(senderEd25519),
                message: new TextEncoder().encode(payload.address),
            })

            if (!verified) {
                return {
                    success: false,
                    message: `${payload.algorithm} payload could not be verified`,
                }
            }
        }

        return {
            success: true,
            message: `Signature proof${
                payloads.length > 1 ? "s" : ""
            } verified. ${JSON.stringify(
                payloads.map(p => p.algorithm),
            )} identities assigned`,
        }
    }

    // SECTION Helper functions and Getters
    /**
     * Get the identities related to a demos address
     * @param address - The address to get the identities of
     * @param chain - The chain to get the identities of
     * @param subchain - The subchain to get the identities of
     * @returns The identities of the address
     */
    static async getXmIdentities(
        address: string,
        chain: string,
        subchain: string,
    ) {
        if (!chain && !subchain) {
            return null
        }

        const data = await this.getIdentities(address, "xm")
        return (data[chain] || {})[subchain] || []
    }

    /**
     * Get the web2 identities related to a demos address
     * @param address - The address to get the identities of
     * @param context - The context of the identities to get
     * @returns The identities of the address
     */
    static async getWeb2Identities(address: string, context: string) {
        const data = await this.getIdentities(address, "web2")
        return data[context] || []
    }

    static async getPQCIdentity(address: string) {
        return await this.getIdentities(address, "pqc")
    }

    /**
     * Get the identities related to a demos address
     * @param address - The address to get the identities of
     * @param key - The key to get the identities of
     * @returns The identities of the address
     */
    static async getIdentities(address: string, key?: string): Promise<any> {
        const gcr = await ensureGCRForUser(address)
        if (key) {
            return gcr.identities[key]
        }

        return gcr.identities
    }
}
