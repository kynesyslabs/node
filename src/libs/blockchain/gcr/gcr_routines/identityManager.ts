import { DefaultChain } from "node_modules/@kynesyslabs/demosdk/build/multichain/core"
import ensureGCRForUser from "./ensureGCRForUser"
import log from "src/utilities/logger"
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
    TRON,
    XRPL,
    BTC,
} from "@kynesyslabs/demosdk/xm-localsdk"

// TODO: refactor import to use high level abstraction module
import { PqcIdentityAssignPayload } from "node_modules/@kynesyslabs/demosdk/build/types/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { CrossChainTools } from "@/libs/identity/tools/crosschain"
import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"

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

// SUPPORTED CHAINS
const chains: { [key: string]: typeof DefaultChain } = {
    solana: SOLANA,
    evm: EVM,
    egld: MULTIVERSX,
    ton: TON,
    tron: TRON,
    xrpl: XRPL,
    ibc: IBC,
    atom: IBC,
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
     * Filter the connections of a user
     *
     * @param sender The ed25519 address of the user
     * @param payload The payload containing the signature to verify
     */
    static async filterConnections(
        sender: string,
        payload: InferFromSignaturePayload,
    ): Promise<{
        success: boolean
        message: string
        twitterAccountConnected: boolean
    }> {
        // INFO: Check if the user has a Twitter account
        const account = await ensureGCRForUser(sender)
        const twitterAccounts = account.identities.web2["twitter"] || []
        let twitterAccountConnected = false

        if (twitterAccounts.length > 0) {
            twitterAccountConnected = true
        }

        const response = {
            success: false,
            twitterAccountConnected,
        }

        // INFO: Check if target address is active
        const { chain, subchain, chainId, targetAddress, isEVM } =
            payload.target_identity

        // SECTION: EVM Checks
        // INFO: Check if the chainId is provided
        if (isEVM && !chainId) {
            return {
                ...response,
                message: "Failed: EVM chainId not provided",
            }
        }

        // INFO: Check if the chainId matches the subchain
        if (isEVM && chainId === chainIds.eth.sepolia) {
            return {
                ...response,
                message: "Failed: Testnet addresses are not supported",
            }
        }

        // INFO: Check if the given chainId and subchain are supported
        if (isEVM && !chainIds.eth[subchain]) {
            return {
                ...response,
                message: "Failed: Unsupported chain",
            }
        }

        // INFO: Check if the chainId matches the subchain
        if (isEVM && chainIds.eth[subchain] !== chainId) {
            return {
                ...response,
                message: "Failed: ChainId does not match the given subchain",
            }
        }

        // INFO: Check if the target address is active
        // if (isEVM && typeof chainId === "number") {
        //     const txcount = await CrossChainTools.countEthTransactionsByAddress(
        //         targetAddress,
        //         chainId,
        //     )

        //     if (txcount === 0) {
        //         return {
        //             success: false,
        //             message: "Failed: Target address is not active",
        //         }
        //     }
        // }

        // SECTION: Mainnet-only chain checks
        // INFO: Some chains only support mainnet for identity management
        const mainnetOnlyChains = ["solana", "tron"]
        if (mainnetOnlyChains.includes(chain) && subchain !== "mainnet") {
            return {
                ...response,
                message: "Failed: Testnet addresses are not supported",
            }
        }

        // INFO: Check if the target address is active
        //     if (chain === "solana") {
        //         const txcount =
        //             await CrossChainTools.countSolanaTransactionsByAddress(
        //                 targetAddress,
        //             )

        //         if (txcount === 0) {
        //             return {
        //                 success: false,
        //                 message: "Failed: Target address is not active",
        //             }
        //         }
        //     }

        return {
            ...response,
            success: true,
            message: "Filter check passed",
        }
    }

    /**
     * Verify the xm identity payload signature
     *
     * @param payload - The payload containing the signature to verify
     *
     * @returns {success: boolean, message: string}
     */
    static async verifyPayload(
        payload: InferFromSignaturePayload,
        sender: string,
    ): Promise<{ success: boolean; message: string }> {
        const { success, message, twitterAccountConnected } =
            await this.filterConnections(sender, payload)

        if (!success) {
            return {
                success: false,
                message: message,
            }
        }

        // Filter out crosschain addresses without activity here!

        const chainId = payload.target_identity.chain
        // @ts-expect-error - This is a workaround to avoid type errors
        const sdk = await chains[chainId].create(null)

        const { signature, publicKey, targetAddress, signedData } =
            payload.target_identity as unknown as InferFromSignatureTargetIdentityPayload

        let messageVerified = false
        try {
            if (
                chainId === "xrpl" ||
                chainId === "ton" ||
                chainId === "ibc" ||
                chainId === "atom" ||
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
                    message: `${chainId} payload signature could not be verified`,
                }
            }

            return {
                success: true,
                message:
                    `${chainId} payload signature verified` +
                    (!twitterAccountConnected
                        ? ". Twitter account not connected, won't award points"
                        : ""),
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
    static async getIdentities(
        address: string,
        key?: "xm" | "web2" | "pqc" | "ud",
    ): Promise<any> {
        const gcr = await ensureGCRForUser(address)
        if (key) {
            return gcr.identities[key]
        }

        return gcr.identities
    }

    static async getUDIdentities(address: string) {
        return await this.getIdentities(address, "ud")
    }
}
