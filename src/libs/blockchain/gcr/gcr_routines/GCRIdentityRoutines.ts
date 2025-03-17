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
        const sender =
            typeof editOperation.account === "string"
                ? editOperation.account
                : forgeToHex(editOperation.account)
        const { chain, subchain, targetAddress } = editOperation.data
        const isEVM = chain === "evm"

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

        const accountGCR = await ensureGCRForUser(sender)

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
        const sender =
            typeof editOperation.account === "string"
                ? editOperation.account
                : forgeToHex(editOperation.account)
        const { chain, subchain, targetAddress } = editOperation.data
        const isEVM = chain === "evm"

        if (!chain || !subchain || !targetAddress) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const normalizedAddress = isEVM
            ? targetAddress.toLowerCase()
            : targetAddress

        const accountGCR = await gcrMainRepository.findOneBy({ pubkey: sender })

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

        const identityEdit = editOperation

        let operation = identityEdit.operation
        if (identityEdit.isRollback) {
            operation = operation === "add" ? "remove" : "add"
        }

        let result: GCRResult
        if (identityEdit.context === "xm") {
            if (operation === "add") {
                result = await this.applyXmIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
            } else if (operation === "remove") {
                result = await this.applyXmIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
            } else {
                result = {
                    success: false,
                    message: "Unsupported identity operation",
                }
            }
        } else if (identityEdit.context === "web2") {
            // TODO implement web2 identity operations
            result = {
                success: false,
                message: "Web2 identity operations not implemented",
            }
        } else {
            result = { success: false, message: "Invalid identity context" }
        }
        return result
    }
}
