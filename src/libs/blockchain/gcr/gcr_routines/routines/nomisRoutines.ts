import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import {
    NomisWalletIdentity,
    SavedNomisIdentity,
} from "@/model/entities/types/IdentityTypes"
import { IncentiveManager } from "../IncentiveManager"
import log from "@/utilities/logger"
import {
    NomisApiClient,
    NomisWalletScorePayload,
} from "@/libs/identity/tools/nomis"
import { safeGCRSave, isFirstConnection, normalizeNomisAddress } from "./utils"

export async function applyNomisIdentityUpsert(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { chain, subchain, address } = editOperation.data

    if (!chain || !subchain || !address) {
        return { success: false, message: "Invalid Nomis identity payload" }
    }

    const normalizedAddress = normalizeNomisAddress(chain, address)

    // The score decides the points awarded, so it comes from Nomis and never
    // from the payload. scoreType, minted score and metadata are the client's
    // to choose in the payload and are not carried over either: a different
    // model or a made-up metadata blob would otherwise be stored as fact.
    let serverPayload: NomisWalletScorePayload
    try {
        serverPayload = await NomisApiClient.getInstance().getWalletScore(
            normalizedAddress,
            { chain },
        )
    } catch (error) {
        log.error("[GCRIdentityRoutines] Failed to fetch Nomis score from API")
        return { success: false, message: "Failed to fetch Nomis score" }
    }

    const score = serverPayload.score
    if (typeof score !== "number" || !Number.isFinite(score) || !score) {
        return { success: false, message: "Nomis returned no score" }
    }

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
        scoreType: serverPayload.scoreType ?? 0,
        mintedScore: serverPayload.mintData?.mintedScore ?? null,
        lastSyncedAt: new Date().toISOString(),
        metadata: {
            referralCode: serverPayload.referralCode,
            referrerCode: serverPayload.referrerCode,
            deadline:
                serverPayload.mintData?.deadline ??
                serverPayload.migrationData?.deadline,
        },
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
