import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import log from "@/utilities/logger"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"
import {
    type EditPlace,
    type RemovedEntry,
    recordedRemoval,
    reinsert,
    removedIdentityKey,
} from "./removedIdentities"
import { sameWeb2UserId } from "@/libs/identity/web2UserId"
import { web2CanonicalIdsActiveAtApply } from "@/forks/web2ProofBindingGate"
import { identityCarryoverActiveAtApply } from "@/forks/identityCarryoverGate"
import { selectWeb2Unlink } from "@/libs/identity/web2Unlink"

export async function applyWeb2IdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { context, data } = editOperation.data as Web2GCRData
    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    const canonicalIds = web2CanonicalIdsActiveAtApply()
    const exists = accountGCR.identities.web2[context].some(
        (id: Web2GCRData["data"]) =>
            id.userId === data.userId ||
            (canonicalIds && sameWeb2UserId(id.userId, data.userId)),
    )

    if (exists) {
        return { success: false, message: "Identity already exists" }
    }

    /**
     * Verify the proof
     */
    let proofOk = false

    if (context === "telegram") {
        // Telegram uses dual signature validation (user + bot signatures)
        // The proof is a TelegramSignedAttestation object, not a URL
        try {
            // Import verifyWeb2Proof which handles telegram verification
            const { verifyWeb2Proof } = await import("@/libs/abstraction")

            const verificationResult = await verifyWeb2Proof(
                {
                    context: "telegram",
                    username: data.username,
                    userId: data.userId,
                    proof: data.proof,
                },
                accountGCR.pubkey, // sender's ed25519 address
            )

            proofOk = verificationResult.success

            if (!proofOk) {
                log.error(
                    `Telegram verification failed: ${verificationResult.message}`,
                )
                return {
                    success: false,
                    message: verificationResult.message,
                }
            }

            log.info(
                `Telegram identity verified: ${data.username} (${data.userId})`,
            )
        } catch (error) {
            log.error(`Telegram proof verification failed: ${error}`)
            proofOk = false
        }
    } else {
        // Standard SHA256 proof validation for other platforms
        proofOk = Hashing.sha256(data.proof) === data.proofHash
    }

    if (!proofOk) {
        return {
            success: false,
            message:
                context === "telegram"
                    ? "Telegram attestation validation failed"
                    : "Sha256 proof mismatch: Expected " +
                      data.proofHash +
                      " but got " +
                      Hashing.sha256(data.proof),
        }
    }

    accountGCR.identities.web2[context].push(data)

    return {
        success: true,
        message: "Web2 identity added",
        entity: accountGCR,
        sideEffect: () =>
            awardWeb2Points(
                context,
                data,
                editOperation.account,
                editOperation.referralCode,
            ),
    }
}

export async function applyWeb2IdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
    place?: EditPlace,
): Promise<GCRResult> {
    const { context, username, userId } = editOperation.data as {
        context: string
        username: string
        userId?: unknown
    }

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    const linked: Web2GCRData["data"][] = accountGCR.identities.web2[context]
    let removed: RemovedEntry<Web2GCRData["data"]>[]
    // The first entry is the link whose points the unlink deducts.
    if (identityCarryoverActiveAtApply()) {
        const pick = selectWeb2Unlink(
            linked,
            { username, userId },
            "Identity not found",
        )
        if ("message" in pick) {
            return { success: false, message: pick.message }
        }
        removed = pick.indexes.map(index => ({ index, value: linked[index] }))
        const first = removed.findIndex(({ value }) => value === pick.removed)
        if (first > 0) removed.unshift(...removed.splice(first, 1))
    } else {
        removed = []
        linked.forEach((id, index) => {
            if (id.username === username) removed.push({ index, value: id })
        })
        if (removed.length === 0) {
            return { success: false, message: "Identity not found" }
        }
    }

    // A simulation leaves nothing to undo, and must not grow the records.
    place?.removed.set(
        removedIdentityKey(
            place,
            editOperation.account,
            "web2",
            context,
            username,
        ),
        removed,
    )

    const drop = new Set(removed.map(({ index }) => index))
    accountGCR.identities.web2[context] = linked.filter((_, i) => !drop.has(i))

    return {
        success: true,
        message: "Web2 identity removed",
        entity: accountGCR,
        sideEffect: () =>
            deductWeb2Points(context, removed[0].value, editOperation.account),
    }
}

/**
 * Undo of an add: takes out the one link the add appended. The add refuses
 * a second link of the same account id, so username and id name it.
 * Points are awarded once per context, so while another link of the context
 * remains they are that link's, and the undo leaves them.
 */
export async function rollbackWeb2IdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { context, data } = (editOperation.data ?? {}) as Partial<Web2GCRData>
    const linked: Web2GCRData["data"][] | undefined =
        accountGCR.identities?.web2?.[context]
    const index = linked
        ? linked.findLastIndex(
              id => id.username === data?.username && id.userId === data?.userId,
          )
        : -1

    if (index === -1) {
        return { success: false, message: "Identity not found" }
    }

    const [link] = linked.splice(index, 1)
    const wasLastOfContext = linked.length === 0

    return {
        success: true,
        message: "Web2 identity add rolled back",
        entity: accountGCR,
        sideEffect: wasLastOfContext
            ? () => deductWeb2Points(context, link, editOperation.account)
            : undefined,
    }
}

/** Undo of a remove: puts back what this node recorded the remove taking. */
export async function rollbackWeb2IdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
    place?: EditPlace,
): Promise<GCRResult> {
    const { context, username } = (editOperation.data ?? {}) as {
        context: string
        username: string
    }
    const removed = recordedRemoval<Web2GCRData["data"]>(place, at =>
        removedIdentityKey(
            at,
            editOperation.account,
            "web2",
            context,
            username,
        ),
    )
    if (!removed) {
        return {
            success: false,
            message: "No record of the removed web2 identity on this node",
        }
    }

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    const linked: Web2GCRData["data"][] =
        accountGCR.identities.web2[context] || []
    // Another account may carry the same username once unlinks pick by
    // account, so only a link of a removed account blocks the undo.
    const back = (id: Web2GCRData["data"]) =>
        removed.some(({ value }) =>
            value.userId === undefined || value.userId === null || value.userId === ""
                ? id.username === value.username
                : id.userId === value.userId ||
                  sameWeb2UserId(id.userId, value.userId),
        )
    if (linked.some(back)) {
        return { success: false, message: "Identity already exists" }
    }

    accountGCR.identities.web2[context] = reinsert(linked, removed)

    return {
        success: true,
        message: "Web2 identity remove rolled back",
        entity: accountGCR,
        sideEffect: () =>
            awardWeb2Points(
                context,
                removed[0].value,
                editOperation.account,
                undefined,
            ),
    }
}

async function deductWeb2Points(
    context: string,
    removed: Web2GCRData["data"],
    account: string,
): Promise<void> {
    if (context === "twitter") {
        await IncentiveManager.twitterUnlinked(account)
    } else if (context === "github" && removed.userId) {
        await IncentiveManager.githubUnlinked(account, removed.userId)
    } else if (context === "telegram" && removed.userId) {
        await IncentiveManager.telegramUnlinked(account)
    } else if (context === "discord") {
        await IncentiveManager.discordUnlinked(account)
    }
}

async function awardWeb2Points(
    context: string,
    data: Web2GCRData["data"],
    account: string,
    referralCode: string | undefined,
): Promise<void> {
    /**
     * Only award points if this is the first time this identity is being connected
     */
    if (context === "twitter") {
        const isFirst = await isFirstConnection(
            "twitter",
            { userId: data.userId },
            account,
        )
        if (isFirst) {
            await IncentiveManager.twitterLinked(
                account,
                data.userId,
                referralCode,
            )
        }
    } else if (context === "github") {
        const isFirst = await isFirstConnection(
            "github",
            { userId: data.userId },
            account,
        )
        if (isFirst) {
            await IncentiveManager.githubLinked(
                account,
                data.userId,
                referralCode,
            )
        }
    } else if (context === "telegram") {
        const isFirst = await isFirstConnection(
            "telegram",
            { userId: data.userId },
            account,
        )
        if (isFirst) {
            // REVIEW: Pass attestation to check group membership for conditional points
            await IncentiveManager.telegramLinked(
                account,
                data.userId,
                referralCode,
                data.proof, // TelegramSignedAttestation with group_membership field
            )
        }
    } else if (context === "discord") {
        const isFirst = await isFirstConnection(
            "discord",
            { userId: data.userId },
            account,
        )
        if (isFirst) {
            await IncentiveManager.discordLinked(
                account,
                referralCode,
            )
        }
    } else {
        log.info(`Web2 identity linked: ${context}/${data.username}`)
    }
}

