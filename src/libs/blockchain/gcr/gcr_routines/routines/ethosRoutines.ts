import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import {
    EthosWalletIdentity,
    SavedEthosIdentity,
} from "@/model/entities/types/IdentityTypes"
import log from "@/utilities/logger"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection, normalizeEthosAddress } from "./utils"

export async function applyEthosIdentityUpsert(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { chain, subchain, address } = editOperation.data

    if (!chain || !subchain || !address) {
        return {
            success: false,
            message:
                "Invalid Ethos identity payload: missing chain, subchain or address",
        }
    }

    // Every node applies this edit, including nodes replaying old blocks, so
    // the stored record has to be a function of the signed payload alone. The
    // score was checked against Ethos when the transaction was accepted.
    const { score, profileId, lastSyncedAt, metadata } = editOperation.data
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
        return {
            success: false,
            message: "Invalid Ethos identity payload: missing score",
        }
    }

    const normalizedAddress = normalizeEthosAddress(chain, address)

    accountGCR.identities.ethos = accountGCR.identities.ethos || {}
    accountGCR.identities.ethos[chain] =
        accountGCR.identities.ethos[chain] || {}
    accountGCR.identities.ethos[chain][subchain] =
        accountGCR.identities.ethos[chain][subchain] || []

    const chainBucket = accountGCR.identities.ethos[chain][subchain]

    const filtered = chainBucket.filter(existing => {
        const existingAddress = normalizeEthosAddress(chain, existing.address)
        return existingAddress !== normalizedAddress
    })

    const record: SavedEthosIdentity = {
        address: normalizedAddress,
        score,
        profileId:
            typeof profileId === "number" && Number.isFinite(profileId)
                ? profileId
                : undefined,
        lastSyncedAt: typeof lastSyncedAt === "string" ? lastSyncedAt : "",
        // Only the fields compared with Ethos at acceptance are kept.
        metadata:
            metadata && typeof metadata === "object"
                ? {
                      displayName:
                          typeof metadata.displayName === "string"
                              ? metadata.displayName
                              : undefined,
                      username:
                          typeof metadata.username === "string"
                              ? metadata.username
                              : undefined,
                  }
                : undefined,
    }

    filtered.push(record)
    accountGCR.identities.ethos[chain][subchain] = filtered

    const awardPoints = async () => {
        const isFirst = await isFirstConnection(
            "ethos",
            {
                chain: chain,
                subchain: subchain,
                address: normalizedAddress,
            },
            editOperation.account,
        )

        log.info(
            `[EthosIdentity] LINKED: account=${accountGCR.pubkey.substring(0, 16)}..., chain=${chain}, subchain=${subchain}, score=${score}, isFirstConnection=${isFirst}`,
        )

        if (isFirst) {
            await IncentiveManager.ethosLinked(
                accountGCR.pubkey,
                chain,
                score,
                editOperation.referralCode,
            )
        }
    }

    return {
        success: true,
        message: "Ethos identity upserted",
        entity: accountGCR,
        sideEffect: awardPoints,
    }
}

export async function applyEthosIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const identity = editOperation.data as EthosWalletIdentity

    if (!identity?.chain || !identity?.subchain || !identity?.address) {
        return { success: false, message: "Invalid Ethos identity payload" }
    }

    const normalizedAddress = normalizeEthosAddress(
        identity.chain,
        identity.address,
    )

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

    const deductPoints = async () => {
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

    return {
        success: true,
        message: "Ethos identity removed",
        entity: accountGCR,
        sideEffect: deductPoints,
    }
}
