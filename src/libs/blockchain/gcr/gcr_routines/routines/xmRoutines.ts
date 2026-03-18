import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { SavedXmIdentity } from "@/model/entities/types/IdentityTypes"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"

export async function applyXmIdentityAdd(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
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

    const accountGCR = await ensureGCRForUser(editOperation.account)

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

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyXmIdentityAdd")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

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
            gcrMainRepository,
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

    return { success: true, message: "Identity applied" }
}

export async function applyXmIdentityRemove(
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

    const accountGCR = await gcrMainRepository.findOneBy({
        pubkey: editOperation.account,
    })

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
        (addr: SavedXmIdentity) =>
            isEVM
                ? addr.address.toLowerCase() === normalizedAddress
                : addr.address === normalizedAddress,
    )

    if (!addressExists) {
        return { success: false, message: "Identity not found" }
    }

    accountGCR.identities.xm[chain][subchain] = accountGCR.identities.xm[
        chain
    ][subchain].filter((id: SavedXmIdentity) =>
        isEVM
            ? id.address.toLowerCase() !== normalizedAddress
            : id.address !== normalizedAddress,
    )

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyXmIdentityRemove")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        /**
         * Deduct incentive points for wallet unlinking
         */
        await IncentiveManager.walletUnlinked(
            accountGCR.pubkey,
            normalizedAddress,
            chain,
        )
    }

    return { success: true, message: "Identity removed" }
}
