// TODO Implement the identity manager
import {
    InferFromGithubPayload,
    InferFromWritePayload,
    InferFromSignatureTargetIdentityPayload,
    XMCoreTargetIdentityPayload,
    InferFromSignaturePayload,
    InferFromTwitterPayload,
} from "@kynesyslabs/demosdk/abstraction"
import { ProviderIdentities, RPCResponse } from "@kynesyslabs/demosdk/types"
import {
    EVM,
    IBC,
    MULTIVERSX,
    NEAR,
    SOLANA,
    TON,
    XRPL,
} from "@kynesyslabs/demosdk/xm-localsdk"

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { DefaultChain } from "node_modules/@kynesyslabs/demosdk/build/multichain/core"
import Datasource from "src/model/datasource"
import ensureGCRForUser from "./ensureGCRForUser"
import log from "src/utilities/logger"
import { updateJSONBValue } from "./gcrJSONBHandler"
import { Cryptography } from "@kynesyslabs/demosdk/encryption"

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
}

export default class IdentityManager {
    // Supported Web2 contexts
    static readonly supportedWeb2Contexts = {
        github: this.inferGithubIdentity,
        twitter: this.inferTwitterIdentity,
    }

    // ? SUPPORTED CHAINS

    constructor() {}

    // SECTION XM Identities

    // Infer identity from a valid write transaction
    static async inferIdentityFromWrite(
        payload: InferFromWritePayload,
    ): Promise<string | false> {
        // TODO Implement: check if the transaction is valid and assign the identity to the target address
        return false
    }

    // Verify the payload signature
    static async verifyPayload(
        payload: InferFromSignaturePayload,
    ): Promise<boolean> {
        const chainId = payload.target_identity.chain
        // @ts-expect-error - This is a workaround to avoid type errors
        const sdk = await chains[chainId].create(null)

        const { signedData, signature, publicKey, targetAddress } =
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
                return false
            }

            return messageVerified
        } catch (error) {
            log.error("Error: " + error)
            return false
        }
    }

    /**
     * @deprecated Identities are now updated as transactions.
     * This method should be safe to remove.
     */
    static async inferIdentityFromSignature(
        sender: string,
        payload: InferFromSignaturePayload,
    ): Promise<RPCResponse> {
        const chainId = payload.target_identity.chain

        // @ts-expect-error - This is a workaround to avoid type errors
        const sdk = await chains[chainId].create(null)

        let messageVerified = false

        try {
            if (
                chainId === "xrpl" ||
                chainId === "ton" ||
                chainId === "ibc" ||
                chainId === "near"
            ) {
                messageVerified = await sdk.verifyMessage(
                    payload.target_identity.signedData,
                    payload.target_identity.signature,
                    payload.target_identity.publicKey,
                )
            } else {
                messageVerified = await sdk.verifyMessage(
                    payload.target_identity.signedData,
                    payload.target_identity.signature,
                    payload.target_identity.targetAddress,
                )
            }
        } catch (error) {
            return {
                result: 400,
                response: "Error: message could not be verified",
                require_reply: false,
                extra: {
                    message: error.toString(),
                },
            }
        }

        if (!messageVerified) {
            return {
                result: 400,
                response: "Signature could not be verified",
                require_reply: false,
                extra: {},
            }
        }

        const gcrEntry = await ensureGCRForUser(sender)

        const newChain = payload.target_identity.chain
        const newSubchain = payload.target_identity.subchain

        // 1: Get existing identites for the user
        const dbData: Record<string, any> = gcrEntry.identities.xm

        // 2: If the chain object does not exist, create it
        if (!dbData[newChain]) {
            dbData[newChain] = {}
        }

        // Check if incoming identity is already in the db
        if (
            (dbData[newChain][newSubchain] || []).includes(
                payload.target_identity.targetAddress,
            )
        ) {
            return {
                result: 304,
                response: "Identity not added: already exists",
                require_reply: false,
                extra: {
                    message: "Identity already exists",
                },
            }
        }

        // 3: Append the new identity to the existing identities
        dbData[newChain][newSubchain] = [
            ...(dbData[newChain][newSubchain] || []),
            payload.target_identity.targetAddress,
        ]

        // 4: Update the database
        const res = await updateJSONBValue(sender, "identities", "xm", dbData)

        if (res.affected === 0) {
            return {
                result: 400,
                response: "Identity could not be added",
                require_reply: false,
                extra: {},
            }
        }

        return {
            result: 200,
            response: "Identity added",
            require_reply: false,
            extra: {
                message:
                    "Identity: " +
                    payload.target_identity.targetAddress +
                    " added to: " +
                    sender,
            },
        }
    }

    // SECTION Web2 Identities
    static async inferGithubIdentity(
        payload: InferFromGithubPayload,
    ): Promise<Boolean> {
        let result: Boolean = false
        // REVIEW  Checking the gist for signatures
        const gistUrl = payload.proof
        // Inferring the github username from the gist url
        //const githubUsername = gistUrl.split("github.com/")[1].split("/")[0]
        // Fetching the gist content
        const gist = await fetch(gistUrl)
        const gistContent = await gist.json()
        // Extracting the public key and signature from the gist content
        const demosPublicKey = gistContent.publicKey
        const demosSignature = gistContent.signature
        // Setting the message to be verified
        const message = "I am demos user: " + demosPublicKey

        // Verify the signature
        const verified = await Cryptography.verify(
            message,
            demosSignature,
            demosPublicKey,
        )
        if (!verified) {
            result = false
        } else {
            result = true
        }
        return result
    }

    static async inferTwitterIdentity(
        payload: InferFromTwitterPayload,
    ): Promise<Boolean> {
        // TODO Fetch a twitter post and verify the signature (as we did for github gists)
        return false
    }
    // SECTION Helper functions and Getters
    /**
     * Get the identities related to a demos address
     * @param address - The address to get the identities of
     * @returns The identities of the address
     */
    static async getXmIdentities(
        address: string,
        chain?: string,
        subchain?: string,
    ) {
        const db = await Datasource.getInstance()
        const gcrRepository = db.getDataSource().getRepository(GCRMain)

        const identities = await gcrRepository.findOne({
            where: { pubkey: address },
            select: ["identities"],
        })

        const data = identities?.identities.xm

        let result = null

        if (chain) {
            result = (data[chain] || {})[subchain] || []
        } else {
            result = data
        }

        return result
    }

    static async removeXmIdentity(
        sender: string,
        payload: XMCoreTargetIdentityPayload,
    ): Promise<RPCResponse> {
        const existingIdentities = await this.getXmIdentities(sender)

        if (!existingIdentities) {
            return {
                result: 404,
                response: "No identities found",
                require_reply: false,
                extra: {
                    message: "No identities found for: " + sender,
                },
            }
        }

        let chainIdentities: string[] =
            existingIdentities[payload.chain][payload.subchain]

        if (
            !chainIdentities ||
            !chainIdentities.includes(payload.targetAddress)
        ) {
            return {
                result: 404,
                response: "Identity not found",
                require_reply: false,
                extra: {
                    message:
                        "Identity: " +
                        payload.targetAddress +
                        " not found for: " +
                        sender,
                },
            }
        }

        chainIdentities = chainIdentities.filter(
            id => id !== payload.targetAddress,
        )

        existingIdentities[payload.chain][payload.subchain] = chainIdentities

        await updateJSONBValue(sender, "identities", "xm", existingIdentities)

        return {
            result: 200,
            response: "Identity removed",
            require_reply: false,
            extra: {
                message:
                    "Identity: " +
                    payload.targetAddress +
                    " removed from: " +
                    sender,
            },
        }
    }

    // Web2 Identities
    static async getWeb2Identifiers(
        address: string,
    ): Promise<ProviderIdentities> {
        const db = await Datasource.getInstance()
        const gcrRepository = db.getDataSource().getRepository(GCRMain)

        const identities = await gcrRepository.findOne({
            where: { pubkey: address },
            select: ["identities"],
        })

        return identities?.identities.web2
    }

    static async addWeb2Identifier(
        address: string,
        context: string,
        proof: string,
    ): Promise<RPCResponse> {
        const db = await Datasource.getInstance()
        const gcrRepository = db.getDataSource().getRepository(GCRMain)

        //  Check if the context is supported
        if (!IdentityManager.supportedWeb2Contexts[context]) {
            return {
                result: 400,
                response: "Context not supported",
                require_reply: false,
                extra: {
                    message: "Context not supported: " + context,
                },
            }
        }
        // Calling the mapped method for the context to verify the proof
        const verified = await IdentityManager.supportedWeb2Contexts[context](
            proof,
        )
        // NOTE All the above methods return a boolean, so we can proceed with the rest of the function here without duplicating code
        if (!verified) {
            return {
                result: 401,
                response: "Proof could not be verified",
                require_reply: false,
                extra: {
                    message: "Proof could not be verified",
                },
            }
        }
        // Adding the proof to the identities
        const identities = await gcrRepository.findOne({
            where: { pubkey: address },
            select: ["identities"],
        })

        identities.identities.web2[context] = [proof]

        await updateJSONBValue(
            address,
            "identities",
            "web2",
            identities.identities,
        )

        return {
            result: 200,
            response: "Identity added",
            require_reply: false,
            extra: {
                message: "Identity added",
            },
        }
    }

    static async addWeb2Identity(
        address: string,
        context: string,
        targetIdentity: string,
    ) {
        
    }

    static async removeWeb2Identifier(
        address: string,
        context: string,
    ): Promise<RPCResponse> {
        const db = await Datasource.getInstance()
        const gcrRepository = db.getDataSource().getRepository(GCRMain)

        const identities = await gcrRepository.findOne({
            where: { pubkey: address },
            select: ["identities"],
        })

        identities.identities.web2[context] = []

        await updateJSONBValue(
            address,
            "identities",
            "web2",
            identities.identities,
        )

        return {
            result: 200,
            response: "Identity removed",
            require_reply: false,
            extra: {
                message: "Identity removed",
            },
        }
    }
}
