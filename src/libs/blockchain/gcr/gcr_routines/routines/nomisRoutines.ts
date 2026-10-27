import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import {
    NomisWalletIdentity,
    SavedNomisIdentity,
} from "@/model/entities/types/IdentityTypes"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection, normalizeNomisAddress } from "./utils"

export async function applyNomisIdentityUpsert(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const {
        chain,
        subchain,
        address,
        score,
        scoreType,
        mintedScore,
        lastSyncedAt,
    } = editOperation.data

    if (!chain || !subchain || !address) {
        return { success: false, message: "Invalid Nomis identity payload" }
    }

    // Every node applies this edit, including nodes replaying old blocks, so
    // the stored record has to be a function of the signed payload alone. The
    // score was checked against Nomis when the transaction was accepted.
    if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) {
        return { success: false, message: "Invalid Nomis identity payload" }
    }

    const normalizedAddress = normalizeNomisAddress(chain, address)

    accountGCR.identities.nomis = accountGCR.identities.nomis || {}
    accountGCR.identities.nomis[chain] =
        accountGCR.identities.nomis[chain] || {}
    accountGCR.identities.nomis[chain][subchain] =
        accountGCR.identities.nomis[chain][subchain] || []

    const chainBucket = accountGCR.identities.nomis[chain][subchain]

    const filtered = chainBucket.filter(existing => {
        const existingAddress = normalizeNomisAddress(chain, existing.address)
        return existingAddress !== normalizedAddress
    })

    const record: SavedNomisIdentity = {
        address: normalizedAddress,
        score,
        scoreType: Number.isInteger(scoreType) ? scoreType : 0,
        mintedScore:
            typeof mintedScore === "number" && Number.isFinite(mintedScore)
                ? mintedScore
                : null,
        // Client metadata is not checked against Nomis, so it is not stored.
        lastSyncedAt: typeof lastSyncedAt === "string" ? lastSyncedAt : "",
    }

    filtered.push(record)
    accountGCR.identities.nomis[chain][subchain] = filtered

    async function awardPoints() {
        const isFirst = await isFirstConnection(
            "nomis",
            {
                chain: chain,
                subchain: subchain,
                address: normalizedAddress,
            },
            editOperation.account,
        )
        if (isFirst) {
            await IncentiveManager.nomisLinked(
                accountGCR.pubkey,
                chain,
                score,
                editOperation.referralCode,
            )
        }
    }

    return {
        success: true,
        message: "Nomis identity upserted",
        entity: accountGCR,
        sideEffect: awardPoints,
    }
}

export async function applyNomisIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const identity = editOperation.data as NomisWalletIdentity

    if (!identity?.chain || !identity?.subchain || !identity?.address) {
        return { success: false, message: "Invalid Nomis identity payload" }
    }

    const normalizedAddress = normalizeNomisAddress(
        identity.chain,
        identity.address,
    )

    const chainBucket =
        accountGCR.identities?.nomis?.[identity.chain]?.[identity.subchain]

    if (!Array.isArray(chainBucket)) {
        return { success: false, message: "Nomis identity not found" }
    }

    const exists = chainBucket.some(existing => {
        const existingAddress = normalizeNomisAddress(
            identity.chain,
            existing.address,
        )
        return existingAddress === normalizedAddress
    })

    if (!exists) {
        return { success: false, message: "Nomis identity not found" }
    }

    accountGCR.identities.nomis[identity.chain][identity.subchain] =
        chainBucket.filter(existing => {
            const existingAddress = normalizeNomisAddress(
                identity.chain,
                existing.address,
            )
            return existingAddress !== normalizedAddress
        })

    async function deductPoints() {
        await IncentiveManager.nomisUnlinked(accountGCR.pubkey, identity.chain)
    }

    return {
        success: true,
        message: "Nomis identity removed",
        entity: accountGCR,
        sideEffect: deductPoints,
    }
}
