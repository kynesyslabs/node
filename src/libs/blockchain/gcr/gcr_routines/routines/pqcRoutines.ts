import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { PqcIdentityEdit } from "@/model/entities/types/IdentityTypes"
import { safeGCRSave } from "./utils"

export async function applyPqcIdentityAdd(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const identities: PqcIdentityEdit[] = editOperation.data

    if (!Array.isArray(identities)) {
        return {
            success: false,
            message: "Invalid edit operation data: expected array",
        }
    }

    const accountGCR = await ensureGCRForUser(editOperation.account)
    accountGCR.identities.pqc = accountGCR.identities.pqc || {}

    for (const identity of identities) {
        const { algorithm, address, signature, timestamp } = identity

        if (!algorithm || !address || !signature || !timestamp) {
            return {
                success: false,
                message:
                    "Invalid identity data: missing algorithm, address or signature",
            }
        }

        accountGCR.identities.pqc[algorithm] =
            accountGCR.identities.pqc[algorithm] || []

        const keyExists = accountGCR.identities.pqc[algorithm].some(
            (key: { address: string; signature: string }) =>
                key.address === address,
        )

        if (keyExists) {
            return {
                success: false,
                message: `Identity already exists for algorithm ${algorithm}`,
            }
        }

        accountGCR.identities.pqc[algorithm].push({
            address,
            signature,
            timestamp,
        })
    }

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyPqcIdentityAdd")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }
    }

    return { success: true, message: "PQC identities added" }
}

export async function applyPqcIdentityRemove(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const identities = editOperation.data

    if (!Array.isArray(identities)) {
        return {
            success: false,
            message: "Invalid edit operation data: expected array",
        }
    }

    const accountGCR = await gcrMainRepository.findOneBy({
        pubkey: editOperation.account,
    })

    if (!accountGCR) {
        return { success: false, message: "Account not found" }
    }

    if (!accountGCR.identities || !accountGCR.identities.pqc) {
        return {
            success: false,
            message: "No PQC identities found",
        }
    }

    for (const identity of identities) {
        const { algorithm, address } = identity

        if (!algorithm || !address) {
            return {
                success: false,
                message:
                    "Invalid identity data: missing algorithm or address",
            }
        }

        if (
            !accountGCR.identities.pqc[algorithm] ||
            !Array.isArray(accountGCR.identities.pqc[algorithm])
        ) {
            return {
                success: false,
                message: `No PQC identities found for algorithm ${algorithm}`,
            }
        }

        const keyExists = accountGCR.identities.pqc[algorithm].some(
            (key: { address: string; signature: string }) =>
                key.address === address,
        )

        if (!keyExists) {
            return {
                success: false,
                message: `Identity not found for algorithm ${algorithm}`,
            }
        }

        accountGCR.identities.pqc[algorithm] = accountGCR.identities.pqc[
            algorithm
        ].filter(
            (key: { address: string; signature: string }) =>
                key.address !== address,
        )
    }

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyPqcIdentityRemove")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }
    }

    return { success: true, message: "PQC identities removed" }
}
