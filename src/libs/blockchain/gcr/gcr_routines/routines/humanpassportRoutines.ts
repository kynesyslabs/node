import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import { SavedHumanPassportIdentity } from "@/model/entities/types/IdentityTypes"
import { humanPassportRecord } from "@/libs/identity/humanPassportClaim"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"

export async function applyHumanPassportIdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    // Every node applies this edit, including nodes replaying old blocks, so
    // the stored record has to be a function of the signed payload alone. The
    // score was checked against Human Passport when the transaction was
    // accepted.
    const record = humanPassportRecord(editOperation.data)
    if (typeof record === "string") {
        return { success: false, message: `Invalid Human Passport identity payload: ${record}` }
    }
    const normalizedAddress = record.address

    accountGCR.identities.humanpassport = (accountGCR.identities.humanpassport ?? []).filter(
        (hp: SavedHumanPassportIdentity) => hp.address.toLowerCase() !== normalizedAddress,
    )
    accountGCR.identities.humanpassport.push(record)

    const awardPoints = async () => {
        // Global uniqueness check across all accounts
        const isFirst = await isFirstConnection(
            "humanpassport",
            { address: normalizedAddress },
            editOperation.account,
        )
        if (isFirst) {
            await IncentiveManager.humanPassportLinked(
                accountGCR.pubkey,
                editOperation.referralCode,
            )
        }
    }

    return {
        success: true,
        message: "Human Passport identity added",
        entity: accountGCR,
        sideEffect: awardPoints,
    }
}

export async function applyHumanPassportIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const data = editOperation.data as { address: string }
    const normalizedAddress = data.address.toLowerCase()

    if (
        !accountGCR.identities.humanpassport ||
        accountGCR.identities.humanpassport.length === 0
    ) {
        return { success: false, message: "No Human Passport identities found" }
    }

    const addressExists = accountGCR.identities.humanpassport.some(
        (hp: SavedHumanPassportIdentity) =>
            hp.address.toLowerCase() === normalizedAddress,
    )

    if (!addressExists) {
        return { success: false, message: "Identity not found" }
    }

    accountGCR.identities.humanpassport =
        accountGCR.identities.humanpassport.filter(
            (hp: SavedHumanPassportIdentity) =>
                hp.address.toLowerCase() !== normalizedAddress,
        )

    const deductPoints = async () => {
        await IncentiveManager.humanPassportUnlinked(accountGCR.pubkey)
    }

    return {
        success: true,
        message: "Human Passport identity removed",
        entity: accountGCR,
        sideEffect: deductPoints,
    }
}
