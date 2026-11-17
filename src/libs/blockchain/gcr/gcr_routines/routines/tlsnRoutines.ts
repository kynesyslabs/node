import { applyTime } from "../../applyTime"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import log from "@/utilities/logger"
import { IncentiveManager } from "../IncentiveManager"
import {
    verifyTLSNProof,
    type TLSNIdentityPayload,
    type TLSNProofRanges,
    type TLSNotaryPresentation,
} from "@/libs/tlsnotary"
import { safeGCRSave, isFirstConnection } from "./utils"
import {
    type EditPlace,
    type RemovedEntry,
    recordedRemoval,
    reinsert,
    removedIdentityKey,
} from "./removedIdentities"
import { sameWeb2UserId } from "@/libs/identity/web2UserId"
import { identityCarryoverActiveAtApply } from "@/forks/identityCarryoverGate"
import { selectWeb2Unlink } from "@/libs/identity/web2Unlink"
import { TLSN_CONTEXTS } from "@/libs/identity/web2Contexts"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"
import type { GCREntityCaches } from "../../handleGCR"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { findTlsnLinkedToken } from "@/libs/tlsnotary/tlsnChainReads"

/** A web2 link as a TLSN link stores it. */
type TLSNLink = Web2GCRData["data"] & { proofType?: string; attestationId?: string }

/** `row` as a TLSN link of transaction `txhash` leaves it: used by `attestationId`. */
function linkedToken(row: GCRTLSNotary, txhash: string | undefined, attestationId: string): GCRTLSNotary {
    const used = Object.assign(new GCRTLSNotary(), row)
    used.status = "linked"
    used.attestationId = attestationId
    used.storedAtHeight = (getSharedState.lastBlockNumber ?? 0) + 1
    // A dry run has no hash; nothing it leaves is stored.
    if (txhash) used.txhash = txhash
    return used
}

/** Takes back the points a TLSN link earned. */
async function deductTLSNPoints(context: string, identity: Web2GCRData["data"], account: string): Promise<void> {
    // Trigger TLSN incentive rollback only for confirmed TLSN provenance.
    if (context === "github" && identity.userId) {
        await IncentiveManager.githubUnlinked(account, identity.userId)
    } else if (context === "discord") {
        await IncentiveManager.discordUnlinked(account)
    } else if (context === "telegram") {
        await IncentiveManager.telegramUnlinked(account)
    }
}

/** Awards the points of a TLSN link, once per platform account. */
async function awardTLSNPoints(
    context: string,
    userId: string,
    account: string,
    referralCode: string | undefined,
): Promise<void> {
    if (context === "github") {
        if (await isFirstConnection("github", { userId }, account)) {
            await IncentiveManager.githubLinked(account, userId, referralCode)
        }
    } else if (context === "discord") {
        if (await isFirstConnection("discord", { userId }, account)) {
            await IncentiveManager.discordLinked(account, referralCode)
        }
    } else if (context === "telegram") {
        if (await isFirstConnection("telegram", { userId }, account)) {
            await IncentiveManager.telegramTLSNLinked(account, userId, referralCode)
        }
    }
}

/** A used token as its request left it, for the undo of its link. */
function freedToken(row: GCRTLSNotary): GCRTLSNotary {
    const free = Object.assign(new GCRTLSNotary(), row)
    free.status = "pending"
    free.attestationId = null
    free.storedAtHeight = null
    free.txhash = row.tokenId
    return free
}

/**
 * Add an identity via TLSNotary proof verification.
 */
export async function applyTLSNIdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
    /** The set being applied, whose links a new one must not repeat. */
    entities?: GCREntityCaches,
): Promise<GCRResult> {
    // Extract context from editOperation.data (top level)
    const { context } = editOperation.data
    // Extract nested data fields (proof, username, userId are inside data.data)
    const {
        proof: proofString,
        recvHash,
        proofRanges,
        revealedRecv,
        username,
        userId,
    } = editOperation.data.data || {}
    // referralCode is at the editOperation level
    const referralCode = editOperation.referralCode

    if (!context) {
        return {
            success: false,
            message: "Missing TLSN context",
        }
    }

    if (!username) {
        return {
            success: false,
            message: "Missing TLSN username",
        }
    }

    if (userId === undefined || userId === null) {
        return {
            success: false,
            message: "Missing TLSN userId",
        }
    }

    if (proofString === undefined || proofString === null) {
        return {
            success: false,
            message: "Missing TLSN proof",
        }
    }

    // Under the fork the identity is read from the verified transcript; the
    // client's own copy of the response is not evidence and is not required.
    const verified = isForkActive(
        "tlsnVerified",
        getSharedState.lastBlockNumber ?? 0,
    )

    if (!verified && !recvHash) {
        return {
            success: false,
            message: "Missing TLSN recvHash",
        }
    }

    if (!verified && !proofRanges) {
        return {
            success: false,
            message: "Missing TLSN proofRanges",
        }
    }

    if (!verified && (revealedRecv === undefined || revealedRecv === null)) {
        return {
            success: false,
            message: "Missing TLSN revealedRecv",
        }
    }

    // Parse the proof JSON string back to object
    let proof: any
    try {
        proof =
            typeof proofString === "string"
                ? JSON.parse(proofString)
                : proofString
    } catch (e) {
        return {
            success: false,
            message: "Invalid proof: failed to parse proof JSON string",
        }
    }

    // 1. Validate context is supported. A set, not an object lookup, so an
    // inherited name such as constructor is not taken for a platform.
    if (!TLSN_CONTEXTS.has(context)) {
        return {
            success: false,
            message: `Unsupported TLSN context: ${context}`,
        }
    }

    // 2. Validate proof structure
    if (!proof || typeof proof !== "object") {
        return {
            success: false,
            message: "Invalid proof: expected TLSNotary presentation object",
        }
    }

    if (!proof.data || !proof.version) {
        return {
            success: false,
            message: "Invalid proof structure: missing data or version",
        }
    }

    // 3. Verify proof and validate recvHash/proofRanges-derived identity claims
    const verification = await verifyTLSNProof(
        {
            context,
            proof: proof as TLSNotaryPresentation,
            recvHash,
            proofRanges: proofRanges as TLSNProofRanges,
            revealedRecv,
            username: String(username),
            userId: String(userId),
            referralCode,
        } as TLSNIdentityPayload,
        {
            sender: editOperation.account,
            accounts: [accountGCR, ...(entities?.accounts.values() ?? [])],
            tokens: entities?.tlsNotaries,
        },
    )

    if (!verification.success) {
        log.warn(
            `[TLSN Identity] Proof verification failed: ${verification.message}`,
        )
        return {
            success: false,
            message: verification.message,
        }
    }

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    // Check if identity already exists (by userId to prevent duplicate registrations)
    const exists = accountGCR.identities.web2[context].some(
        (id: Web2GCRData["data"]) => id.userId === String(userId),
    )

    if (exists) {
        return { success: false, message: "Identity already exists" }
    }

    // 9. Prepare data for storage
    const proofHash = Hashing.sha256(JSON.stringify(proof))
    const data = {
        userId: String(userId),
        username: username,
        proof: proof,
        proofHash: proofHash,
        proofType: "tlsn", // Mark as TLSNotary-verified
        timestamp: applyTime().getTime(),
        // The replay key: the presentation bytes are malleable, the
        // notary-signed attestation id is not.
        ...(verification.attestationId
            ? { attestationId: verification.attestationId }
            : {}),
    }

    accountGCR.identities.web2[context].push(data)

    const awardPoints = () =>
        awardTLSNPoints(context, String(userId), editOperation.account, referralCode)

    // Under tlsnVerified the link uses its request token up.
    const token =
        verification.token && verification.attestationId
            ? linkedToken(verification.token, editOperation.txhash, verification.attestationId)
            : undefined

    return {
        success: true,
        message: "TLSN identity added successfully",
        entity: accountGCR,
        sideEffect: awardPoints,
        ...(token ? { tlsNotary: token } : {}),
    }
}

/**
 * Remove an identity that was added via TLSNotary.
 *
 * Removes only TLSN-proven identities (proofType === "tlsn") from web2 storage.
 */
export async function applyTLSNIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
    place?: EditPlace,
): Promise<GCRResult> {
    const { context, username, userId } = editOperation.data as {
        context?: string
        username?: string
        userId?: unknown
    }

    // Under the fork a userId alone names the link, as it does for web2.
    const named = identityCarryoverActiveAtApply()
        ? Boolean(username) || (userId !== undefined && userId !== null && userId !== "")
        : Boolean(username)
    if (!context || !named) {
        return {
            success: false,
            message: "Invalid payload: missing context or username",
        }
    }

    if (!TLSN_CONTEXTS.has(context)) {
        return {
            success: false,
            message: `Unsupported TLSN context: ${context}`,
        }
    }

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    const links: TLSNLink[] = accountGCR.identities.web2[context]
    let removed: RemovedEntry<TLSNLink>[]
    // The first entry is the link whose points the unlink deducts.
    if (identityCarryoverActiveAtApply()) {
        const pick = selectWeb2Unlink(
            links,
            { username, userId },
            "TLSN identity not found",
            id => id.proofType === "tlsn",
        )
        if ("message" in pick) {
            return { success: false, message: pick.message }
        }
        removed = pick.indexes.map(index => ({ index, value: links[index] }))
        const first = removed.findIndex(({ value }) => value === pick.removed)
        if (first > 0) removed.unshift(...removed.splice(first, 1))
    } else {
        // TLSN remove must never affect legacy/non-TLSN web2 identities.
        removed = []
        links.forEach((id, index) => {
            if (id.proofType === "tlsn" && id.username === username) {
                removed.push({ index, value: id })
            }
        })
        if (removed.length === 0) {
            return { success: false, message: "TLSN identity not found" }
        }
    }

    // The remove edit names the link but does not carry it (the proof and
    // attestation id travel only in the add), so its undo needs this record.
    // A simulation leaves nothing to undo, and must not grow the records.
    place?.removed.set(
        removedIdentityKey(place, editOperation.account, "tlsn", context),
        removed,
    )

    const drop = new Set(removed.map(({ index }) => index))
    accountGCR.identities.web2[context] = links.filter((_, i) => !drop.has(i))

    const identity = removed[0].value
    return {
        success: true,
        message: "TLSN identity removed successfully",
        entity: accountGCR,
        sideEffect: () => deductTLSNPoints(context, identity, editOperation.account),
    }
}

/**
 * The undo of a TLSN link: drops the link the add wrote, named by the add's
 * own payload, and frees the request token it used, if it used one. The
 * remove routine cannot do it: a remove edit names the link at its top
 * level, an add nests it under `data.data`. Nothing is verified again: the
 * undo only reverses what the add wrote.
 */
export async function rollbackTLSNIdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
    entities?: GCREntityCaches,
): Promise<GCRResult> {
    const { context } = editOperation.data ?? {}
    const { username, userId } = editOperation.data?.data ?? {}
    if (!TLSN_CONTEXTS.has(context) || userId === undefined || userId === null) {
        return { success: false, message: "Invalid payload: missing context or userId" }
    }
    const links: TLSNLink[] = accountGCR.identities?.web2?.[context] ?? []
    const at = links.findIndex(
        id => id.proofType === "tlsn" && id.userId === String(userId) && id.username === username,
    )
    if (at < 0) return { success: false, message: "TLSN identity not found" }
    const link = links[at]

    // Only a link made under tlsnVerified carries an attestation id, and
    // only such a link used a request token: a pre-fork link has none to
    // free, and its undo must not need the database.
    const used =
        link.attestationId && typeof editOperation.txhash === "string"
            ? await findTlsnLinkedToken(editOperation.txhash, entities?.tlsNotaries)
            : null

    links.splice(at, 1)
    accountGCR.identities.web2[context] = links
    // Points are awarded once per account and platform: an add that found
    // them already paid (by another link of the context, web2 or TLSN)
    // awarded nothing. Undo runs from the tip down, so a link of the context
    // still here is older than this one and holds those points. Only the
    // context's last link can have earned them, as for a web2 link. Whether
    // the add paid is decided in a side effect after the block commits, so
    // the apply's undo records never hold it.
    const wasLastOfContext = links.length === 0

    return {
        success: true,
        message: "TLSN identity add rolled back",
        entity: accountGCR,
        sideEffect: wasLastOfContext
            ? () => deductTLSNPoints(context, link, editOperation.account)
            : undefined,
        ...(used ? { tlsNotary: freedToken(used) } : {}),
    }
}

/**
 * The undo of a TLSN unlink: puts back, in place, the links this node
 * recorded the unlink taking, as they were (proof, attestation id and all).
 * The request token a link used stays used through its unlink, so there is
 * no token to change back. Nothing is verified again.
 */
export async function rollbackTLSNIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
    place?: EditPlace,
): Promise<GCRResult> {
    const { context } = (editOperation.data ?? {}) as { context?: string }
    if (!context || !TLSN_CONTEXTS.has(context)) {
        return { success: false, message: `Unsupported TLSN context: ${String(context)}` }
    }
    const removed = recordedRemoval<TLSNLink>(place, at =>
        removedIdentityKey(at, editOperation.account, "tlsn", context),
    )
    if (!removed) {
        return {
            success: false,
            message: "No record of the removed TLSN identity on this node",
        }
    }

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    const links: TLSNLink[] = accountGCR.identities.web2[context] || []
    // A TLSN unlink leaves the account's other web2 links, a gist link of
    // the same platform account among them, so only a TLSN link blocks it.
    const back = (id: TLSNLink) =>
        id.proofType === "tlsn" &&
        removed.some(({ value }) =>
            value.userId === undefined || value.userId === null || value.userId === ""
                ? id.username === value.username
                : id.userId === value.userId || sameWeb2UserId(id.userId, value.userId),
        )
    if (links.some(back)) {
        return { success: false, message: "Identity already exists" }
    }

    accountGCR.identities.web2[context] = reinsert(links, removed)

    const first = removed[0].value
    return {
        success: true,
        message: "TLSN identity remove rolled back",
        entity: accountGCR,
        sideEffect: () =>
            awardTLSNPoints(context, String(first.userId), editOperation.account, undefined),
    }
}
