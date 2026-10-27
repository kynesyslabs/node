import { DefaultChain } from "node_modules/@kynesyslabs/demosdk/build/multichain/core"
import ensureGCRForUser from "./ensureGCRForUser"
import log from "src/utilities/logger"
import {
    InferFromWritePayload,
    InferFromSignatureTargetIdentityPayload,
    InferFromSignaturePayload,
} from "@kynesyslabs/demosdk/abstraction"
import {
    APTOS,
    EVM,
    IBC,
    MULTIVERSX,
    NEAR,
    SOLANA,
    TON,
    XRPL,
    BTC,
} from "@kynesyslabs/demosdk/xm-localsdk"

// TODO: refactor import to use high level abstraction module
import { PqcIdentityAssignPayload } from "node_modules/@kynesyslabs/demosdk/build/types/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { CrossChainTools } from "@/libs/identity/tools/crosschain"
import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"
import { NomisWalletIdentity, SavedHumanPassportIdentity, EthosWalletIdentity } from "@/model/entities/types/IdentityTypes"
import { HumanPassportProvider } from "@/libs/identity/tools/humanpassport"
import { verifyMessage as verifyEvmMessage } from "ethers"
import TxValidatorPool from "../../validation/txValidatorPool"
import { NomisApiClient } from "@/libs/identity/tools/nomis"
import { EthosApiClient } from "@/libs/identity/tools/ethos"
import {
    isParsableTimestamp,
    sameOptionalProviderNumber,
    sameOptionalString,
    sameProviderNumber,
} from "@/libs/identity/scoreBinding"
import { normalizeEthosAddress, normalizeNomisAddress } from "./routines/utils"
import { xmProofBindingActiveForPendingBlock } from "@/forks/xmProofBindingGate"
import {
    KEY_DERIVED_CHAINS,
    checkAddressDerivedFromKey,
    checkXmDisplayAddress,
    canonicalXmAddress,
    checkXmSignedData,
} from "@/libs/identity/xmProof"

function normalizeComparableAddress(address: string | undefined | null): string {
    return (address || "").trim().toLowerCase()
}

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
    xrpl: XRPL,
    ibc: IBC,
    atom: IBC,
    near: NEAR,
    // @ts-expect-error - BTC module contains more fields than the DefaultChain type
    btc: BTC,
    // @ts-expect-error - APTOS module contains more fields than the DefaultChain type
    aptos: APTOS,
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

        // SECTION: SOLANA Checks
        // INFO: Check if the subchain is mainnet
        if (chain === "solana" && subchain !== "mainnet") {
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
        if (!Object.prototype.hasOwnProperty.call(chains, chainId)) {
            return {
                success: false,
                message: `Unsupported chain: ${chainId}`,
            }
        }

        const {
            signature,
            publicKey,
            targetAddress,
            signedData,
            displayAddress,
        } = payload.target_identity as unknown as InferFromSignatureTargetIdentityPayload

        // The address is stored under displayAddress when one is sent, so it
        // has to be the address that was proven.
        const displayCheck = checkXmDisplayAddress(
            chainId,
            targetAddress,
            displayAddress,
        )
        if (displayCheck.ok === false) {
            return { success: false, message: displayCheck.message }
        }

        // These verifiers check the signature against the key the client
        // sent; without this the key is not tied to the address at all.
        if ((KEY_DERIVED_CHAINS as readonly string[]).includes(chainId)) {
            const keyCheck = checkAddressDerivedFromKey({
                chain: chainId,
                subchain: payload.target_identity.subchain,
                publicKey,
                targetAddress,
            })
            if (keyCheck.ok === false) {
                return { success: false, message: keyCheck.message }
            }
        }

        if (xmProofBindingActiveForPendingBlock()) {
            const bound = checkXmSignedData({
                chain: chainId,
                targetAddress,
                sender,
                signedData,
            })
            if (bound.ok === false) {
                return { success: false, message: bound.message }
            }
        }

        // @ts-expect-error - This is a workaround to avoid type errors
        const sdk = await chains[chainId].create(null)

        let messageVerified = false
        try {
            if (
                chainId === "xrpl" ||
                chainId === "ton" ||
                chainId === "ibc" ||
                chainId === "atom" ||
                chainId === "near" ||
                chainId === "aptos"
            ) {
                messageVerified = await sdk.verifyMessage(
                    signedData,
                    signature,
                    publicKey,
                )
            } else if (chainId === "evm") {
                const recoveredAddress = verifyEvmMessage(
                    signedData,
                    signature,
                )
                messageVerified =
                    normalizeComparableAddress(recoveredAddress) ===
                    normalizeComparableAddress(targetAddress)
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
            const verified = await TxValidatorPool.getInstance().verify({
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
            message: `Signature proof${payloads.length > 1 ? "s" : ""
                } verified. ${JSON.stringify(
                    payloads.map(p => p.algorithm),
                )} identities assigned`,
        }
    }

    /**
     * Whether `address` is already linked to `sender` through a verified xm
     * identity. Score identities (Nomis, Ethos, Human Passport) read a public
     * score for an address; they say nothing about who controls it, so the
     * wallet-ownership proof is the xm signature the account already made.
     * EVM and Solana addresses are the same on every subchain, so any subchain
     * counts.
     */
    static async isXmWalletLinked(
        sender: string,
        chain: string,
        address: string,
    ): Promise<boolean> {
        const xm = (await this.getIdentities(sender, "xm")) || {}
        const byChain = xm[chain] || {}
        const wanted = canonicalXmAddress(chain, address)
        return Object.values(byChain).some(
            (list: any) =>
                Array.isArray(list) &&
                list.some(
                    (id: { address?: string }) =>
                        canonicalXmAddress(chain, id?.address ?? "") === wanted,
                ),
        )
    }

    /**
     * Verify a Nomis identity assign payload before the transaction is
     * accepted. Apply stores the signed score as is and never asks Nomis, so
     * this is the only place the score is checked against the provider: the
     * signed score, scoreType and mintedScore must equal what Nomis reports
     * for the default model now, and an unreachable Nomis refuses the
     * transaction.
     *
     * @param payload - The signed payload
     * @param sender - The Demos account the transaction comes from
     */
    static async verifyNomisPayload(
        payload: NomisWalletIdentity,
        sender: string,
    ): Promise<{ success: boolean; message: string }> {
        if (!payload.chain || !payload.subchain || !payload.address) {
            return {
                success: false,
                message:
                    "Invalid Nomis identity payload: missing chain, subchain or address",
            }
        }

        if (
            typeof payload.score !== "number" ||
            !Number.isFinite(payload.score) ||
            payload.score <= 0 ||
            !Number.isInteger(payload.scoreType) ||
            !isParsableTimestamp(payload.lastSyncedAt)
        ) {
            return {
                success: false,
                message:
                    "Invalid Nomis identity payload: score, scoreType and lastSyncedAt are required",
            }
        }

        if (!(await this.isXmWalletLinked(sender, payload.chain, payload.address))) {
            return {
                success: false,
                message:
                    "Nomis wallet is not linked to this account: link it as a cross-chain identity first",
            }
        }

        let fetched: Awaited<ReturnType<NomisApiClient["getWalletScore"]>>
        try {
            fetched = await NomisApiClient.getInstance().getWalletScore(
                normalizeNomisAddress(payload.chain, payload.address),
                { chain: payload.chain },
            )
        } catch {
            return {
                success: false,
                message: "Could not confirm the Nomis score with Nomis; try again later",
            }
        }

        if (
            !sameProviderNumber(payload.score, fetched?.score) ||
            payload.scoreType !== (fetched?.scoreType ?? 0) ||
            !sameOptionalProviderNumber(
                payload.mintedScore,
                fetched?.mintData?.mintedScore,
            )
        ) {
            return {
                success: false,
                message:
                    "Nomis score in the transaction does not match the score Nomis reports; fetch it again",
            }
        }

        return {
            success: true,
            message: "Nomis identity payload verified",
        }
    }

    /**
     * Verify an Ethos identity assign payload before the transaction is
     * accepted. Apply stores the signed score as is and never asks Ethos, so
     * this is the only place the score is checked against the provider: the
     * signed score and profileId (and displayName/username when metadata is
     * sent) must equal what Ethos reports now, and an unreachable Ethos
     * refuses the transaction.
     *
     * @param payload - The signed payload
     * @param sender - The Demos account the transaction comes from
     */
    static async verifyEthosPayload(
        payload: EthosWalletIdentity,
        sender: string,
    ): Promise<{ success: boolean; message: string }> {
        if (!payload.chain || !payload.subchain || !payload.address) {
            return {
                success: false,
                message:
                    "Invalid Ethos identity payload: missing chain, subchain or address",
            }
        }

        if (
            typeof payload.score !== "number" ||
            !Number.isFinite(payload.score) ||
            payload.score < 0 ||
            !isParsableTimestamp(payload.lastSyncedAt)
        ) {
            return {
                success: false,
                message:
                    "Invalid Ethos identity payload: score and lastSyncedAt are required",
            }
        }

        if (!(await this.isXmWalletLinked(sender, payload.chain, payload.address))) {
            return {
                success: false,
                message:
                    "Ethos wallet is not linked to this account: link it as a cross-chain identity first",
            }
        }

        let fetched: Awaited<ReturnType<EthosApiClient["getScore"]>>
        try {
            fetched = await EthosApiClient.getInstance().getScore(
                normalizeEthosAddress(payload.chain, payload.address),
            )
        } catch {
            return {
                success: false,
                message: "Could not confirm the Ethos score with Ethos; try again later",
            }
        }

        const metadataMatches =
            payload.metadata == null ||
            (sameOptionalString(
                payload.metadata.displayName,
                fetched?.displayName,
            ) &&
                sameOptionalString(payload.metadata.username, fetched?.username))

        if (
            !sameProviderNumber(payload.score, fetched?.score) ||
            !sameOptionalProviderNumber(payload.profileId, fetched?.profileId) ||
            !metadataMatches
        ) {
            return {
                success: false,
                message:
                    "Ethos score in the transaction does not match the score Ethos reports; fetch it again",
            }
        }

        return {
            success: true,
            message: "Ethos identity payload verified",
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
        key?: "xm" | "web2" | "pqc" | "ud" | "nomis" | "humanpassport" | "ethos",
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

    // SECTION: Human Passport Identity

    /**
     * Verify the payload for a Human Passport identity assign
     *
     * Validates the address and fetches the score from Human Passport API.
     * Requires score >= 20 (passing threshold) to succeed.
     *
     * @param payload - The payload containing the address and signature
     * @param sender - The transaction sender's address (for binding verification)
     * @returns {success: boolean, message: string, data?: SavedHumanPassportIdentity}
     */
    static async verifyHumanPassportPayload(
        payload: {
            address: string
            signature?: string
            verificationMethod: "api" | "onchain"
            chainId?: number
            referralCode?: string
        },
        sender: string,
    ): Promise<{ success: boolean; message: string; data?: SavedHumanPassportIdentity }> {
        // payload.signature is not consulted: ownership of the address is the
        // xm identity the sender already proved, checked below.

        // TODO: Implement verificationMethod branching
        // Currently both "api" and "onchain" use identical API verification logic
        // "onchain" should query on-chain passport data when implemented

        // Note: referralCode is processed in GCRIdentityRoutines.applyHumanPassportIdentityAdd
        // It's passed through the editOperation, not used here

        const { address, verificationMethod } = payload

        if (!address) {
            return {
                success: false,
                message: "Invalid Human Passport payload: missing address",
            }
        }

        if (!(await this.isXmWalletLinked(sender, "evm", address))) {
            return {
                success: false,
                message:
                    "Human Passport wallet is not linked to this account: link it as a cross-chain identity first",
            }
        }

        try {
            // Verify score via Human Passport API
            const provider = HumanPassportProvider.getInstance()
            const verification = await provider.verifyAddress(address)

            if (!verification.passingScore) {
                return {
                    success: false,
                    message: `Human Passport score ${verification.score} below threshold (${verification.threshold}). ` +
                        "User needs to verify more stamps at https://app.passport.xyz/. Transaction not applied.",
                }
            }

            // Build saved identity
            const savedIdentity: SavedHumanPassportIdentity = {
                address: verification.address,
                score: verification.score,
                passingScore: verification.passingScore,
                threshold: verification.threshold,
                stamps: verification.stamps,
                verificationMethod: verificationMethod,
                chainId: payload.chainId,
                verifiedAt: verification.verifiedAt,
                expiresAt: verification.expirationTimestamp
                    ? new Date(verification.expirationTimestamp).getTime()
                    : null,
            }

            log.info(
                `[IdentityManager] Human Passport verified: ${address} ` +
                `(score: ${verification.score}, stamps: ${verification.stamps.length})`,
            )

            return {
                success: true,
                message: `Human Passport identity verified with score ${verification.score}`,
                data: savedIdentity,
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.error(`[IdentityManager] Human Passport verification failed: ${errorMsg}`)
            return {
                success: false,
                message: errorMsg || "Failed to verify Human Passport identity",
            }
        }
    }

    /**
     * Get Human Passport identities for a Demos address
     */
    static async getHumanPassportIdentities(
        address: string,
    ): Promise<SavedHumanPassportIdentity[]> {
        const identities = await this.getIdentities(address, "humanpassport")
        return identities || []
    }

    /**
     * Get Human Passport score for an address (fetches from API)
     */
    static async getHumanPassportScore(address: string): Promise<{
        address: string
        score: number
        passingScore: boolean
        stamps: string[]
    } | null> {
        try {
            const provider = HumanPassportProvider.getInstance()
            const verification = await provider.verifyAddress(address)
            return {
                address: verification.address,
                score: verification.score,
                passingScore: verification.passingScore,
                stamps: verification.stamps,
            }
        } catch {
            return null
        }
    }
}
