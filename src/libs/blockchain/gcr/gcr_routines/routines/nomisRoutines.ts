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
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const {
        chain,
        subchain,
        address,
        score,
        scoreType,
        mintedScore,
        metadata,
        lastSyncedAt,
    } = editOperation.data

    if (!chain || !subchain || !address || !score) {
        return { success: false, message: "Invalid Nomis identity payload" }
    }

    const normalizedAddress = normalizeNomisAddress(chain, address)

    const isFirst = await isFirstConnection(
        "nomis",
        {
            chain: chain,
            subchain: subchain,
            address: normalizedAddress,
        },
        gcrMainRepository,
        editOperation.account,
    )

    const accountGCR = await ensureGCRForUser(editOperation.account)

    accountGCR.identities.nomis = accountGCR.identities.nomis || {}
    accountGCR.identities.nomis[chain] =
        accountGCR.identities.nomis[chain] || {}
    accountGCR.identities.nomis[chain][subchain] =
        accountGCR.identities.nomis[chain][subchain] || []

    const chainBucket = accountGCR.identities.nomis[chain][subchain]

    const filtered = chainBucket.filter(existing => {
        const existingAddress = normalizeNomisAddress(
            chain,
            existing.address,
        )
        return existingAddress !== normalizedAddress
    })

    const record: SavedNomisIdentity = {
        address: normalizedAddress,
        score,
        scoreType,
        mintedScore: mintedScore ?? null,
        lastSyncedAt: lastSyncedAt || new Date().toISOString(),
        metadata,
    }

    filtered.push(record)
    accountGCR.identities.nomis[chain][subchain] = filtered

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyNomisIdentityUpsert")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        if (isFirst) {
            await IncentiveManager.nomisLinked(
                accountGCR.pubkey,
                chain,
                score,
                editOperation.referralCode,
            )
        }
    }

    return { success: true, message: "Nomis identity upserted" }
}

export async function applyNomisIdentityRemove(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const identity = editOperation.data as NomisWalletIdentity

    if (!identity?.chain || !identity?.subchain || !identity?.address) {
        return { success: false, message: "Invalid Nomis identity payload" }
    }

    const normalizedAddress = normalizeNomisAddress(
        identity.chain,
        identity.address,
    )

    const accountGCR = await gcrMainRepository.findOneBy({
        pubkey: editOperation.account,
    })

    if (!accountGCR) {
        return { success: false, message: "Account not found" }
    }

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

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyNomisIdentityRemove")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        await IncentiveManager.nomisUnlinked(
            accountGCR.pubkey,
            identity.chain,
        )
    }

    return { success: true, message: "Nomis identity removed" }
}
