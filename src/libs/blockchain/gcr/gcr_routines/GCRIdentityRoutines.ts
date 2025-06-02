import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import { GCREdit, Web2GCRData } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import ensureGCRForUser from "./ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import log from "@/utilities/logger"
import { IncentiveManager } from "./IncentiveManager"

export default class GCRIdentityRoutines {
    static async applyXmIdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { chain, isEVM, subchain, targetAddress } = editOperation.data

        if (
            !chain ||
            !subchain ||
            typeof isEVM !== "boolean" ||
            !targetAddress
        ) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const normalizedAddress = isEVM
            ? targetAddress.toLowerCase()
            : targetAddress

        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.xm[chain] = accountGCR.identities.xm[chain] || {}
        accountGCR.identities.xm[chain][subchain] =
            accountGCR.identities.xm[chain][subchain] || []

        const addressExists = accountGCR.identities.xm[chain][subchain].some(
            (addr: string) =>
                isEVM
                    ? addr.toLowerCase() === normalizedAddress
                    : addr === normalizedAddress,
        )

        if (addressExists) {
            return { success: false, message: "Identity already exists" }
        }

        accountGCR.identities.xm[chain][subchain].push(normalizedAddress)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Check if this is the first connection
             */
            const isFirst = await this.isFirstConnection(
                "web3",
                {
                    chain,
                    subchain,
                    address: normalizedAddress,
                },
                gcrMainRepository,
                editOperation.account,
            )

            /**
             * Award incentive points for wallet linking
             */
            if (isFirst) {
                await IncentiveManager.walletLinked(
                    accountGCR.pubkey,
                    normalizedAddress,
                    chain,
                )
            }
        }

        return { success: true, message: "Identity applied" }
    }

    static async applyXmIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { chain, isEVM, subchain, targetAddress } = editOperation.data

        if (!chain || !subchain || !targetAddress) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const normalizedAddress = isEVM
            ? targetAddress.toLowerCase()
            : targetAddress

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        if (
            !accountGCR.identities ||
            !accountGCR.identities.xm ||
            !accountGCR.identities.xm[chain] ||
            !Array.isArray(accountGCR.identities.xm[chain][subchain])
        ) {
            return {
                success: false,
                message: "No identities found for the specified chain/subchain",
            }
        }

        const addressExists = accountGCR.identities.xm[chain][subchain].some(
            (addr: string) =>
                isEVM
                    ? addr.toLowerCase() === normalizedAddress
                    : addr === normalizedAddress,
        )

        if (!addressExists) {
            return { success: false, message: "Identity not found" }
        }

        accountGCR.identities.xm[chain][subchain] = accountGCR.identities.xm[
            chain
        ][subchain].filter((id: string) =>
            isEVM
                ? id.toLowerCase() !== normalizedAddress
                : id !== normalizedAddress,
        )

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "Identity removed" }
    }

    static async applyWeb2IdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, data } = editOperation.data as Web2GCRData
        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        const exists = accountGCR.identities.web2[context].some(
            (id: Web2GCRData["data"]) => id.userId === data.userId,
        )

        if (exists) {
            return { success: false, message: "Identity already exists" }
        }

        /**
         * Verify the proof
         */
        const proofOk = Hashing.sha256(data.proof) === data.proofHash
        if (!proofOk) {
            return {
                success: false,
                message:
                    "Sha256 proof mismatch: Expected " +
                    data.proofHash +
                    " but got " +
                    Hashing.sha256(data.proof),
            }
        }

        accountGCR.identities.web2[context].push(data)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Only award points if this is the first time this identity is being connected
             */
            if (context === "twitter") {
                const isFirst = await this.isFirstConnection(
                    "twitter",
                    { userId: data.userId },
                    gcrMainRepository,
                    editOperation.account,
                )
                if (isFirst) {
                    await IncentiveManager.twitterLinked(editOperation.account)
                }
            } else if (context === "github") {
                // Future implementation for GitHub
                log.info(
                    `GitHub linking for ${data.username}, no incentive handler yet`,
                )
            } else {
                log.info(`Web2 identity linked: ${context}/${data.username}`)
            }
        }

        return { success: true, message: "Web2 identity added" }
    }

    static async applyWeb2IdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, username } = editOperation.data
        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        const exists = accountGCR.identities.web2[context].some(
            (id: Web2GCRData["data"]) => id.username === username,
        )

        if (!exists) {
            return { success: false, message: "Identity not found" }
        }

        accountGCR.identities.web2[context] = accountGCR.identities.web2[
            context
        ].filter((id: Web2GCRData["data"]) => id.username !== username)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "Web2 identity removed" }
    }

    static async apply(
        editOperation: GCREdit,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        if (
            editOperation.type !== "identity" ||
            !("context" in editOperation)
        ) {
            return {
                success: false,
                message: "Invalid edit operation for identity routine",
            }
        }

        const identityEdit = structuredClone(editOperation)

        let operation = identityEdit.operation
        if (identityEdit.isRollback) {
            operation = operation === "add" ? "remove" : "add"
        }

        let result: GCRResult

        // CONVERT operation.account to hex
        identityEdit.account =
            typeof identityEdit.account === "string"
                ? identityEdit.account
                : forgeToHex(identityEdit.account)

        switch (identityEdit.context + operation) {
            case "xmadd":
                result = await this.applyXmIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "xmremove":
                result = await this.applyXmIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2add":
                result = await this.applyWeb2IdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2remove":
                result = await this.applyWeb2IdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            default:
                result = {
                    success: false,
                    message: "Unsupported identity operation",
                }
        }

        return result
    }

    private static async isTwitterUserIdUnique(
        userId: string,
        gcrMainRepository: Repository<GCRMain>,
    ): Promise<boolean> {
        /**
         * Query to check if this userId exists in any account's Twitter identities
         */
        const result = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where("gcr.identities->'web2'->'twitter' @> :userId", {
                userId: JSON.stringify([{ userId }]),
            })
            .getOne()

        /**
         * Return true if no account has this userId
         */
        return !result
    }

    private static async isFirstConnection(
        type: "twitter" | "web3",
        data: {
            userId?: string // for twitter
            chain?: string // for web3
            subchain?: string // for web3
            address?: string // for web3
        },
        gcrMainRepository: Repository<GCRMain>,
        currentAccount?: string,
    ): Promise<boolean> {
        if (type === "twitter") {
            /**
             * Check if this Twitter userId exists anywhere
             */
            const result = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where("gcr.identities->'web2'->'twitter' @> :userId", {
                    userId: JSON.stringify([{ userId: data.userId }]),
                })
                .getOne()

            /**
             * Return true if no account has this userId
             */
            return !result
        } else {
            /**
             * For web3 wallets, check if this address exists in any account for this chain/subchain
             */
            const result = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where("gcr.identities->'xm'->:chain->:subchain @> :address", {
                    chain: data.chain,
                    subchain: data.subchain,
                    address: JSON.stringify([data.address.toLowerCase()]),
                })
                .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
                .getOne()

            /**
             * Return true if this is the first connection
             */
            return !result
        }
    }
}
