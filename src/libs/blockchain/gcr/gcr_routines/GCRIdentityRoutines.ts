import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import ensureGCRForUser from "./ensureGCRForUser"

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

        const accountGCR = await gcrMainRepository.findOneBy({ pubkey: editOperation.account })

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
        const { context, username } = editOperation.data
        const accountGCR = await ensureGCRForUser(editOperation.account)
        accountGCR.identities.web2 = accountGCR.identities.web2 || new Map()
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        if (accountGCR.identities.web2[context].includes(username)) {
            return { success: false, message: "Identity already exists" }
        }

        accountGCR.identities.web2[context].push(username)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
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

        accountGCR.identities.web2 = accountGCR.identities.web2 || new Map()
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        if (!accountGCR.identities.web2[context].includes(username)) {
            return { success: false, message: "Identity not found" }
        }

        accountGCR.identities.web2[context] = accountGCR.identities.web2[
            context
        ].filter((id: string) => id !== username)

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
}
