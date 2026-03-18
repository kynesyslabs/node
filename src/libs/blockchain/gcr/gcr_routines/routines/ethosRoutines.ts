import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import {
    EthosWalletIdentity,
    SavedEthosIdentity,
} from "@/model/entities/types/IdentityTypes"
import { EthosApiClient } from "@/libs/identity/tools/ethos"
import log from "@/utilities/logger"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection, normalizeEthosAddress } from "./utils"

export async function applyEthosIdentityUpsert(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const {
        chain,
        subchain,
        address,
    } = editOperation.data

    if (!chain || !subchain || !address) {
        return { success: false, message: "Invalid Ethos identity payload: missing chain, subchain or address" }
    }

    const normalizedAddress = normalizeEthosAddress(chain, address)

    // Fetch authoritative score from Ethos API server-side
    const ethosClient = EthosApiClient.getInstance()
    let serverScore: number
    let serverProfileId: number | undefined
    let serverMetadata: { displayName?: string; username?: string } | undefined

    try {
        const ethosData = await ethosClient.getScore(normalizedAddress)
        serverScore = ethosData.score
        serverProfileId = ethosData.profileId
        serverMetadata = {
            displayName: ethosData.displayName,
            username: ethosData.username,
        }
    } catch (error: any) {
        log.error(`[GCRIdentityRoutines] Failed to fetch Ethos score from API`)
        return { success: false, message: "Failed to fetch Ethos score" }
    }

    const isFirst = await isFirstConnection(
        "ethos",
        {
            chain: chain,
            subchain: subchain,
            address: normalizedAddress,
        },
        gcrMainRepository,
        editOperation.account,
    )

    const accountGCR = await ensureGCRForUser(editOperation.account)

    accountGCR.identities.ethos = accountGCR.identities.ethos || {}
    accountGCR.identities.ethos[chain] =
        accountGCR.identities.ethos[chain] || {}
    accountGCR.identities.ethos[chain][subchain] =
        accountGCR.identities.ethos[chain][subchain] || []

    const chainBucket = accountGCR.identities.ethos[chain][subchain]

    const filtered = chainBucket.filter(existing => {
        const existingAddress = normalizeEthosAddress(
            chain,
            existing.address,
        )
        return existingAddress !== normalizedAddress
    })

    const record: SavedEthosIdentity = {
        address: normalizedAddress,
        score: serverScore,
        profileId: serverProfileId,
        lastSyncedAt: new Date().toISOString(),
        metadata: serverMetadata,
    }

    filtered.push(record)
    accountGCR.identities.ethos[chain][subchain] = filtered

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyEthosIdentityUpsert")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        log.info(
            `[EthosIdentity] LINKED: account=${accountGCR.pubkey.substring(0, 16)}..., chain=${chain}, subchain=${subchain}, score=${serverScore}, isFirstConnection=${isFirst}`,
        )

        if (isFirst) {
            await IncentiveManager.ethosLinked(
                accountGCR.pubkey,
                chain,
                serverScore,
                editOperation.referralCode,
            )
        }
    }

    return { success: true, message: "Ethos identity upserted" }
}

export async function applyEthosIdentityRemove(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const identity = editOperation.data as EthosWalletIdentity

    if (!identity?.chain || !identity?.subchain || !identity?.address) {
        return { success: false, message: "Invalid Ethos identity payload" }
    }

    const normalizedAddress = normalizeEthosAddress(
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
        accountGCR.identities?.ethos?.[identity.chain]?.[identity.subchain]

    if (!Array.isArray(chainBucket)) {
        return { success: false, message: "Ethos identity not found" }
    }

    const exists = chainBucket.some(existing => {
        const existingAddress = normalizeEthosAddress(
            identity.chain,
            existing.address,
        )
        return existingAddress === normalizedAddress
    })

    if (!exists) {
        return { success: false, message: "Ethos identity not found" }
    }

    const filteredBucket = chainBucket.filter(existing => {
        const existingAddress = normalizeEthosAddress(
            identity.chain,
            existing.address,
        )
        return existingAddress !== normalizedAddress
    })

    accountGCR.identities.ethos[identity.chain][identity.subchain] =
        filteredBucket

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyEthosIdentityRemove")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        // Only deduct points if NO Ethos identities remain for this chain
        // (checking all subchains, since points are tracked per-chain)
        const chainIdentities = accountGCR.identities.ethos[identity.chain]
        const hasRemainingIdentities = Object.values(chainIdentities).some(
            subchainBucket =>
                Array.isArray(subchainBucket) && subchainBucket.length > 0,
        )

        log.info(
            `[EthosIdentity] UNLINKED: account=${accountGCR.pubkey.substring(0, 16)}..., chain=${identity.chain}, subchain=${identity.subchain}, pointsDeducted=${!hasRemainingIdentities}`,
        )

        if (!hasRemainingIdentities) {
            await IncentiveManager.ethosUnlinked(
                accountGCR.pubkey,
                identity.chain,
            )
        }
    }

    return { success: true, message: "Ethos identity removed" }
}
