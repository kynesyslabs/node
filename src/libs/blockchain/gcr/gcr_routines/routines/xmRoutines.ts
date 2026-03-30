import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { SavedXmIdentity } from "@/model/entities/types/IdentityTypes"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"

export async function applyXmIdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
    // gcrMainRepository: Repository<GCRMain>,
    // simulate: boolean,
): Promise<GCRResult> {
    const {
        chain,
        isEVM,
        subchain,
        targetAddress,
        signature,
        timestamp,
        signedData,
        displayAddress,
    } = editOperation.data

    // REVIEW: Is there a better way to check this?
    if (
        !chain ||
        !subchain ||
        typeof isEVM !== "boolean" ||
        !targetAddress ||
        !signature ||
        !timestamp ||
        !signedData
    ) {
        return { success: false, message: "Invalid edit operation data" }
    }

    const addressToStore = displayAddress || targetAddress
    const normalizedAddress = isEVM
        ? addressToStore.toLowerCase()
        : addressToStore

    // const accountGCR = await ensureGCRForUser(editOperation.account)

    accountGCR.identities.xm[chain] = accountGCR.identities.xm[chain] || {}
    accountGCR.identities.xm[chain][subchain] =
        accountGCR.identities.xm[chain][subchain] || []

    const addressExists = accountGCR.identities.xm[chain][subchain].some(
        (id: SavedXmIdentity) =>
            isEVM
                ? id.address.toLowerCase() === normalizedAddress
                : id.address === normalizedAddress,
    )

    if (addressExists) {
        return { success: false, message: "Identity already exists" }
    }

    const data = {
        address: normalizedAddress,
        signature: editOperation.data.signature,
        publicKey: editOperation.data.publicKey || "",
        timestamp: editOperation.data.timestamp,
        signedData: editOperation.data.signedData,
    }

    accountGCR.identities.xm[chain][subchain].push(data)
    async function awardPoints() {
        /**
         * Check if this is the first connection
         */
        const isFirst = await isFirstConnection(
            "web3",
            {
                chain,
                subchain,
                address: normalizedAddress,
            },
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
                editOperation.referralCode,
            )
        }
    }

    return {
        success: true,
        message: "Identity applied",
        entity: accountGCR,
        sideEffect: awardPoints,
    }
}

export async function applyXmIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { chain, isEVM, subchain, targetAddress } = editOperation.data

    if (!chain || !subchain || !targetAddress) {
        return { success: false, message: "Invalid edit operation data" }
    }

    const normalizedAddress = isEVM
        ? targetAddress.toLowerCase()
        : targetAddress

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
        (addr: SavedXmIdentity) =>
            isEVM
                ? addr.address.toLowerCase() === normalizedAddress
                : addr.address === normalizedAddress,
    )

    if (!addressExists) {
        return { success: false, message: "Identity not found" }
    }

    accountGCR.identities.xm[chain][subchain] = accountGCR.identities.xm[chain][
        subchain
    ].filter((id: SavedXmIdentity) =>
        isEVM
            ? id.address.toLowerCase() !== normalizedAddress
            : id.address !== normalizedAddress,
    )

    async function deductPoints() {
        /**
         * Deduct incentive points for wallet unlinking
         */
        await IncentiveManager.walletUnlinked(
            accountGCR.pubkey,
            normalizedAddress,
            chain,
        )
    }

    return {
        success: true,
        message: "Identity removed",
        entity: accountGCR,
        sideEffect: deductPoints,
    }
}
