// TODO Implement the identity manager
import {
    EVM,
    IBC,
    MULTIVERSX,
    NEAR,
    SOLANA,
    TON,
    XRPL,
} from "@kynesyslabs/demosdk/xm-localsdk"
import { abstraction } from "@kynesyslabs/demosdk"
import { RPCResponse } from "@kynesyslabs/demosdk/types"

import Datasource from "src/model/datasource"
import ensureGCRForUser from "./ensureGCRForUser"
import { updateJSONBValue } from "./gcrJSONBHandler"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import { DefaultChain } from "node_modules/@kynesyslabs/demosdk/build/multichain/core"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"

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

interface ChainData {
    sdk: typeof DefaultChain
    rpc: { [key: string]: string },
    networkId?: string
}

const chainData: { [key: string]: ChainData } = {
    solana: {
        sdk: SOLANA,
        rpc: chainProviders.solana,
    },
    evm: {
        sdk: EVM,
        rpc: chainProviders.evm,
    },
    egld: {
        sdk: MULTIVERSX,
        rpc: chainProviders.egld,
    },
    ton: {
        sdk: TON,
        rpc: chainProviders.ton,
    },
    xrpl: {
        sdk: XRPL,
        rpc: chainProviders.xrpl,
    },
    ibc: {
        sdk: IBC,
        rpc: chainProviders.ibc
    },
    near: {
        sdk: NEAR,
        rpc: chainProviders.near,
        networkId: "mainnet"
    }
}

export default class IdentityManager {
    // INFO: SUPPORTED CHAINS
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
        sender: string,
        payload: abstraction.InferFromSignaturePayload,
    ): Promise<RPCResponse> {
        const chainId = payload.target_identity.chain

        // @ts-expect-error
        const sdk = await chainData[chainId].sdk.create(null)

        let messageVerified = false

        try {
            if (chainId === "xrpl" || chainId === "ton" || chainId === "ibc") {
                messageVerified = await sdk.verifyMessage(
                    payload.target_identity.signedData,
                    payload.target_identity.signature,
                    payload.target_identity.publicKey,
                )
            }
            else {
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

        await ensureGCRForUser(sender)
        const dbData: Record<string, any> = await this.getIdentities(sender)

        if (!dbData[payload.target_identity.chain]) {
            dbData[payload.target_identity.chain] = {}
        }

        dbData[payload.target_identity.chain][
            payload.target_identity.subchain
        ] = [
            ...((dbData[payload.target_identity.chain] || {})[
                payload.target_identity.subchain
            ] || []),
            payload.target_identity.targetAddress,
        ]

        const res = await updateJSONBValue(
            sender,
            "details",
            "content",
            dbData,
            `identities, xm`,
        )

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

    // SECTION Helper functions
    /**
     * Get the identities related to a demos address
     * @param address - The address to get the identities of
     * @returns The identities of the address
     */
    static async getIdentities(
        address: string,
        chain?: string,
        subchain?: string,
    ) {
        const db = await Datasource.getInstance()
        const GCRRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        const identities = await GCRRepository.findOne({
            where: { publicKey: address },
            select: ["details"],
        })

        let data = identities?.details.content.identities.xm

        let result = null

        if (chain) {
            result = (data[chain] || {})[subchain] || []
        } else if (chain) {
            result = data[chain] || {}
        } else {
            result = data
        }

        return result
    }

    static async removeIdentity(
        sender: string,
        payload: abstraction.CoreTargetIdentityPayload,
    ): Promise<RPCResponse> {
        let existingIdentities = await this.getIdentities(sender)

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

        await updateJSONBValue(
            sender,
            "details",
            "content",
            existingIdentities,
            `identities, xm`,
        )

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
}
