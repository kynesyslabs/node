import crypto from "crypto"

import bs58 from "bs58"

import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { assertRollbackBoundary } from "@/libs/atomic-work/effectBoundary"
import { assertIntentWithinLimits, type AtomicWorkLimits } from "@/libs/atomic-work/limits"
import { validateOperationGraph } from "@/libs/atomic-work/operationGraph"
import { atomicWorkProfile } from "@/libs/atomic-work/profile"
import { computeWorkId } from "@/libs/atomic-work/workId"
import { matchWritesToOperations } from "@/libs/atomic-work/workReceipt"

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

/** Multicodec prefix of an ed25519 public key inside a `did:key`. */
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01])

/**
 * The ed25519 key a `did:key` names. A `did:key` is the key itself, encoded,
 * so every validator reads the same key from it without resolving anything.
 */
function didKeyEd25519(did: string): Buffer | null {
    const match = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did)
    if (!match) return null
    let bytes: Uint8Array
    try {
        bytes = bs58.decode(match[1])
    } catch {
        return null
    }
    if (bytes.length !== 34) return null
    const raw = Buffer.from(bytes)
    if (!raw.subarray(0, 2).equals(ED25519_MULTICODEC)) return null
    return raw.subarray(2)
}

function signerKey(signer: unknown): Buffer | null {
    const key =
        typeof signer === "string"
            ? signer
            : typeof (signer as { publicKey?: unknown })?.publicKey === "string"
              ? (signer as { publicKey: string }).publicKey
              : null
    if (!key) return null
    if (key.startsWith("did:")) return didKeyEd25519(key)
    if (!/^(0x)?[0-9a-f]{64}$/i.test(key)) return null
    return Buffer.from(key.replace(/^0x/, ""), "hex")
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

/**
 * Verify an ed25519 signature whose signer claim carries the public key
 * itself: a Demos address, `{ publicKey }`, or an ed25519 `did:key`. A claim
 * that only names a key (a registry DID, `did:web:…`) is refused: resolving it
 * needs a registry or the network, and validators could resolve it
 * differently, or not at all, for the same block.
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
    submitter: string,
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

    if (attempt.attemptClass === "replay") {
        // A replay is charged no fee, so any transfer it carried would move
        // funds for free, as often as the sender cares to replay.
        if (transferCount !== 0) return refuse("a replay carries no transfers")
        return { success: true, message: "replay envelope" }
    }

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

    if (transferCount > 0 && profile.assertSubmitter) {
        try {
            profile.assertSubmitter(intent, submitter)
        } catch (error) {
            return refuse(error instanceof Error ? error.message : String(error))
        }
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
    // A Work that rolls a slot back is the failure outcome: it moves its
    // slots to rolled-back and changes nothing else, so its receipt can say
    // rolled-back and mean it.
    const rollingBack = edits.some(
        e => e.type === "resource-slot-cas" && e.transition === "rollback",
    )
    const expected = rollingBack ? { ...declared, storage: 0, transfer: 0 } : declared
    for (const effect of ["storage", "slot", "transfer"] as const) {
        if (expected[effect] !== carried[effect]) {
            return refuse(
                rollingBack && effect !== "slot"
                    ? `a Work that rolls back carries no ${effect} effects; this one carries ${carried[effect]}`
                    : `intent declares ${declared[effect]} ${effect} effect(s); the transaction carries ${carried[effect]}`,
            )
        }
    }
    if (!rollingBack) {
        try {
            matchWritesToOperations(
                operations as never,
                edits.filter(e => e.type === "storage-program-put") as never,
            )
        } catch (error) {
            return refuse(error instanceof Error ? error.message : String(error))
        }
    }
    for (const e of edits) {
        if (e.type === "resource-slot-cas" && e.workId !== workId) {
            return refuse(`${e.type} names a Work other than this intent's`)
        }
    }
    return { success: true, message: "Work envelope" }
}
