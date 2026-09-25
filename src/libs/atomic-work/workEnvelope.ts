import crypto from "crypto"

import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { assertRollbackBoundary } from "@/libs/atomic-work/effectBoundary"
import { assertIntentWithinLimits, type AtomicWorkLimits } from "@/libs/atomic-work/limits"
import { validateOperationGraph } from "@/libs/atomic-work/operationGraph"
import { atomicWorkProfile } from "@/libs/atomic-work/profile"
import { computeWorkId } from "@/libs/atomic-work/workId"

/**
 * Binding what a Work transaction does to the intent it was authorized as.
 *
 * The edits say what changes; the intent says what was agreed. Without this
 * check a sender could sign well-formed edits for a Work nobody authorized,
 * or reuse a Work id for different bytes. Every fact checked here is
 * recomputed from the intent, never taken from the edits.
 */

export interface WorkEnvelope {
    intent?: Record<string, unknown>
    authorizations?: Record<string, unknown>[]
}

export type SignatureVerifier = (input: {
    signer: unknown
    signedBytes: string
    signature: string
}) => boolean

type Outcome = { success: boolean; message: string }
const refuse = (message: string): Outcome => ({ success: false, message })

/**
 * Which edit carries each native operation kind's effect. Kinds not listed
 * here (assertions) change no state of their own.
 */
const EFFECT_OF_KIND: Record<string, "storage" | "slot" | "transfer"> = {
    "storage-program-put": "storage",
    "resource-slot-cas": "slot",
    "payment-slot-cas": "slot",
    "native-dem-transfer": "transfer",
}

/** sha256 of the intent's canonical bytes: the attempt's `canonicalBytesHash`. */
export function intentBytesHash(intent: unknown): string {
    return Hashing.sha256(jcsCanonicalize(intent))
}

function decodeSignature(signature: string): Buffer | null {
    if (/^(0x)?[0-9a-f]{128}$/i.test(signature)) return Buffer.from(signature.replace(/^0x/, ""), "hex")
    const raw = Buffer.from(signature, "base64url")
    return raw.length === 64 ? raw : null
}

function signerKey(signer: unknown): Buffer | null {
    const key =
        typeof signer === "string"
            ? signer
            : typeof (signer as { publicKey?: unknown })?.publicKey === "string"
              ? (signer as { publicKey: string }).publicKey
              : null
    if (!key || !/^(0x)?[0-9a-f]{64}$/i.test(key)) return null
    return Buffer.from(key.replace(/^0x/, ""), "hex")
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

/**
 * Verify an ed25519 signature whose signer claim carries the public key
 * itself: a Demos address, or `{ publicKey }`. A claim that names a key
 * indirectly (a DID, say) is refused, because resolving it is not something
 * every validator can do the same way.
 */
export const ed25519SignerVerifier: SignatureVerifier = ({ signer, signedBytes, signature }) => {
    const key = signerKey(signer)
    const sig = decodeSignature(signature)
    if (!key || !sig) return false
    try {
        const publicKey = crypto.createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
            format: "der",
            type: "spki",
        })
        return crypto.verify(null, Buffer.from(signedBytes, "utf8"), publicKey, sig)
    } catch {
        return false
    }
}

/**
 * Check a Work transaction's envelope against its edits.
 *
 * `edits` are the transaction's GCR edits and `transferCount` the number of
 * transfers its payload declares. A replay only has to prove it is the same
 * Work; anything else must also be within limits, match its profile's
 * operation graph, carry every required authorization, and produce exactly
 * the effects its operations declare.
 */
export function assertWorkEnvelope(
    envelope: WorkEnvelope | undefined,
    edits: ReadonlyArray<{ type: string } & Record<string, unknown>>,
    transferCount: number,
    limits: AtomicWorkLimits,
    verifySignature: SignatureVerifier,
): Outcome {
    const intent = envelope?.intent
    if (!intent || typeof intent !== "object") return refuse("a Work transaction must carry its intent")

    const profile = atomicWorkProfile(intent.profile as string | undefined)
    if (!profile) {
        return refuse(`profile ${String(intent.profile)} is not registered on this node`)
    }

    const attempt = edits.find(e => e.type === "work-attempt")
    if (!attempt) return refuse("a Work transaction must carry its attempt")

    let bytesHash: string
    let workId: string
    try {
        bytesHash = intentBytesHash(intent)
        workId = computeWorkId(intent, profile.domains.workId)
    } catch (error) {
        return refuse(`intent is not canonical JSON: ${error}`)
    }
    if (attempt.canonicalBytesHash !== bytesHash) {
        return refuse("the attempt's canonicalBytesHash is not the hash of this intent")
    }
    if (attempt.workId !== workId) return refuse("the attempt's workId is not derived from this intent")

    if (attempt.attemptClass === "replay") return { success: true, message: "replay envelope" }

    const operations = (intent.operations ?? []) as { operationId: string; kind: string }[]
    try {
        assertIntentWithinLimits(intent as { operations?: unknown[] }, limits)
        validateOperationGraph(intent as never)
        assertRollbackBoundary(operations)
    } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error))
    }

    if (!profile.verifyAuthorizations) {
        return refuse(`profile ${profile.name} cannot authorize operations on this node`)
    }
    try {
        profile.verifyAuthorizations(intent, envelope?.authorizations ?? [], workId, verifySignature)
    } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error))
    }

    const declared = { storage: 0, slot: 0, transfer: 0 }
    for (const op of operations) {
        const effect = EFFECT_OF_KIND[op.kind]
        if (effect) declared[effect]++
    }
    const carried = {
        storage: edits.filter(e => e.type === "storage-program-put").length,
        slot: edits.filter(e => e.type === "resource-slot-cas").length,
        transfer: transferCount,
    }
    for (const effect of ["storage", "slot", "transfer"] as const) {
        if (declared[effect] !== carried[effect]) {
            return refuse(
                `intent declares ${declared[effect]} ${effect} effect(s); the transaction carries ${carried[effect]}`,
            )
        }
    }
    for (const e of edits) {
        if (e.type === "resource-slot-cas" && e.workId !== workId) {
            return refuse(`${e.type} names a Work other than this intent's`)
        }
    }
    return { success: true, message: "Work envelope" }
}
