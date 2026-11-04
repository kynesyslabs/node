import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { SavedXmIdentity } from "@/model/entities/types/IdentityTypes"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"
import {
    type RemovedEntry,
    recordRemovedIdentities,
    reinsert,
    removedIdentities,
    removedIdentityKey,
} from "./removedIdentities"

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

    const matches = (id: SavedXmIdentity) =>
        isEVM
            ? id.address.toLowerCase() === normalizedAddress
            : id.address === normalizedAddress
    const linked: SavedXmIdentity[] = accountGCR.identities.xm[chain][subchain]
    const removed: RemovedEntry<SavedXmIdentity>[] = []
    linked.forEach((id, index) => {
        if (matches(id)) removed.push({ index, value: id })
    })

    if (removed.length === 0) {
        return { success: false, message: "Identity not found" }
    }

    recordRemovedIdentities(
        removedIdentityKey(
            editOperation.txhash,
            editOperation.account,
            "xm",
            chain,
            subchain,
            normalizedAddress,
        ),
        removed,
    )

    accountGCR.identities.xm[chain][subchain] = linked.filter(
        id => !matches(id),
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

/**
 * Undo of an add: takes out the one entry the add appended, found by the
 * address the add stored (the display form when one was given).
 */
export async function rollbackXmIdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { chain, isEVM, subchain, targetAddress, displayAddress, signature } =
        editOperation.data ?? {}
    const stored = displayAddress || targetAddress
    if (!chain || !subchain || !stored) {
        return { success: false, message: "Invalid edit operation data" }
    }
    const address = isEVM ? stored.toLowerCase() : stored

    const linked: SavedXmIdentity[] | undefined =
        accountGCR.identities?.xm?.[chain]?.[subchain]
    const index = Array.isArray(linked)
        ? linked.findLastIndex(
              id => id.address === address && id.signature === signature,
          )
        : -1
    if (index === -1) {
        return { success: false, message: "Identity not found" }
    }

    linked.splice(index, 1)

    return {
        success: true,
        message: "Identity add rolled back",
        entity: accountGCR,
        sideEffect: async () => {
            await IncentiveManager.walletUnlinked(
                accountGCR.pubkey,
                address,
                chain,
            )
        },
    }
}

/** Undo of a remove: puts back what this node recorded the remove taking. */
export async function rollbackXmIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { chain, isEVM, subchain, targetAddress } = editOperation.data ?? {}
    if (!chain || !subchain || !targetAddress) {
        return { success: false, message: "Invalid edit operation data" }
    }
    const normalizedAddress = isEVM
        ? targetAddress.toLowerCase()
        : targetAddress

    const removed = removedIdentities<SavedXmIdentity>(
        removedIdentityKey(
            editOperation.txhash,
            editOperation.account,
            "xm",
            chain,
            subchain,
            normalizedAddress,
        ),
    )
    if (!removed) {
        return {
            success: false,
            message: "No record of the removed cross-chain identity on this node",
        }
    }

    accountGCR.identities.xm = accountGCR.identities.xm || {}
    accountGCR.identities.xm[chain] = accountGCR.identities.xm[chain] || {}
    const linked: SavedXmIdentity[] =
        accountGCR.identities.xm[chain][subchain] || []
    const present = linked.some(id =>
        isEVM
            ? id.address.toLowerCase() === normalizedAddress
            : id.address === normalizedAddress,
    )
    if (present) {
        return { success: false, message: "Identity already exists" }
    }

    accountGCR.identities.xm[chain][subchain] = reinsert(linked, removed)

    return {
        success: true,
        message: "Identity remove rolled back",
        entity: accountGCR,
        sideEffect: async () => {
            const isFirst = await isFirstConnection(
                "web3",
                { chain, subchain, address: normalizedAddress },
                editOperation.account,
            )
            if (isFirst) {
                await IncentiveManager.walletLinked(
                    accountGCR.pubkey,
                    normalizedAddress,
                    chain,
                )
            }
        },
    }
}
