import { beforeAll, describe, expect, it } from "bun:test"

import { storageValueDigest } from "@/libs/atomic-work/storageWrite"
import crypto from "crypto"

import vectors from "@/libs/atomic-work/__fixtures__/workid.vectors.json"
import { AUTH_DOMAIN, computeAuthorizationHash } from "@/libs/atomic-work/dacs/authorization"
import { DACS_DOMAINS } from "@/libs/atomic-work/dacs/domains"
import { registerDacsAtomicWorkProfiles } from "@/libs/atomic-work/dacs/profile"
import { declareNativeOperationKinds } from "@/libs/atomic-work/effectBoundary"
import { DEFAULT_ATOMIC_WORK_LIMITS } from "@/libs/atomic-work/limits"
import {
    assertWorkEnvelope,
    ed25519SignerVerifier,
    intentBytesHash,
} from "@/libs/atomic-work/workEnvelope"
import { computeWorkId } from "@/libs/atomic-work/workId"

const reference = (vectors as { cases: { intent: Record<string, any>; workId: string }[] }).cases[0]

function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
    return { hex: "0x" + raw.toString("hex"), privateKey }
}

// The reference intent, with DID signers swapped for keys a node can check.
const keys = Object.fromEntries(["buyer", "seller", "orchestrator", "payer"].map(r => [r, keypair()]))
const intent = structuredClone(reference.intent)
const SUBMITTER = "0x" + "5e".repeat(32)
intent.roleRoster = intent.roleRoster.map((r: any) => ({
    ...r,
    signer: keys[r.role].hex,
    ...(r.role === "payer" ? { nativeAccount: SUBMITTER } : {}),
}))
const workId = computeWorkId(intent, DACS_DOMAINS.workId)

function authorizations(sign = true) {
    return intent.operations.flatMap((op: any, operationIndex: number) =>
        op.requiredRoles.map((role: string) => {
            const auth: Record<string, unknown> = {
                authorizationVersion: "1",
                algorithm: "ed25519",
                workId,
                executionProfile: intent.executionProfile,
                networkId: intent.networkId,
                railId: intent.railId,
                jobId: intent.jobId,
                phaseIndex: intent.phaseIndex,
                operationId: op.operationId,
                operationIndex,
                operationKind: op.kind,
                role,
                signer: keys[role].hex,
            }
            const bytes = Buffer.from(AUTH_DOMAIN + computeAuthorizationHash(auth), "utf8")
            auth.value = sign ? crypto.sign(null, bytes, keys[role].privateKey).toString("base64url") : "x"
            return auth
        }),
    )
}

const attempt = { type: "work-attempt", workId, attemptId: "a1", canonicalBytesHash: intentBytesHash(intent) }
// Each write carries the value its operation declares; the envelope pairs
// them by that value.
const puts = intent.operations
    .filter((op: any) => op.kind === "storage-program-put")
    .map((op: any) => ({ type: "storage-program-put", valueDigest: storageValueDigest(op.payload.artifact) }))
const slot = { type: "resource-slot-cas", workId }
const receipt = { type: "work-receipt", workId }
// The purchase graph writes three times, claims one slot and pays once.
const edits = [attempt, ...puts, slot, receipt]

const check = (over: { env?: any; edits?: any[]; transfers?: number } = {}) =>
    assertWorkEnvelope(
        over.env ?? { intent, authorizations: authorizations() },
        (over.edits ?? edits) as never,
        over.transfers ?? 1,
        DEFAULT_ATOMIC_WORK_LIMITS,
        ed25519SignerVerifier,
        SUBMITTER,
    )

beforeAll(() => {
    declareNativeOperationKinds()
    registerDacsAtomicWorkProfiles()
})

describe("assertWorkEnvelope", () => {
    it("derives the reference workId from the reference intent", () => {
        expect(computeWorkId(reference.intent, DACS_DOMAINS.workId)).toBe(reference.workId)
    })

    it("accepts a purchase whose edits, ids and signatures all match its intent", () => {
        expect(check()).toEqual({ success: true, message: "Work envelope" })
    })

    it("refuses a workId or bytes hash not derived from the intent", () => {
        expect(check({ edits: [{ ...attempt, workId: "0".repeat(64) }, ...puts, slot, receipt] }).success).toBe(false)
        expect(check({ edits: [{ ...attempt, canonicalBytesHash: "0".repeat(64) }, ...puts, slot, receipt] }).success).toBe(false)
    })

    it("refuses an unregistered profile and a missing intent", () => {
        expect(check({ env: { intent: { ...intent, profile: "nobody-v1" }, authorizations: authorizations() } }).message).toContain("not registered")
        expect(check({ env: {} }).message).toContain("intent")
    })

    it("refuses a bad or missing signature", () => {
        expect(check({ env: { intent, authorizations: authorizations(false) } }).message).toContain("signature")
        expect(check({ env: { intent, authorizations: authorizations().slice(1) } }).success).toBe(false)
    })

    it("refuses a DID signer it cannot resolve", () => {
        const didIntent = structuredClone(reference.intent)
        const didWorkId = computeWorkId(didIntent, DACS_DOMAINS.workId)
        const result = assertWorkEnvelope(
            { intent: didIntent, authorizations: [] },
            [{ ...attempt, workId: didWorkId, canonicalBytesHash: intentBytesHash(didIntent) }, ...puts, { ...slot, workId: didWorkId }, { ...receipt, workId: didWorkId }] as never,
            1,
            DEFAULT_ATOMIC_WORK_LIMITS,
            ed25519SignerVerifier,
            SUBMITTER,
        )
        expect(result.success).toBe(false)
    })

    it("refuses effects the intent does not declare", () => {
        expect(check({ edits: [attempt, puts[0], puts[1], slot, receipt] }).message).toContain("storage")
        expect(check({ transfers: 2 }).message).toContain("transfer")
        expect(check({ edits: [attempt, ...puts, { ...slot, workId: "other" }, receipt] }).success).toBe(false)
    })

    it("refuses writes whose values their operations do not declare", () => {
        const stray = { type: "storage-program-put", valueDigest: "0".repeat(64) }
        expect(check({ edits: [attempt, puts[0], puts[1], stray, slot, receipt] }).message).toContain("with its value")
        // Order does not matter; the values do.
        expect(check({ edits: [attempt, puts[2], puts[0], puts[1], slot, receipt] }).success).toBe(true)
    })

    it("accepts a Work that rolls its slot back only when it carries no other effects", () => {
        const rollback = { ...slot, transition: "rollback" }
        expect(check({ edits: [attempt, rollback, receipt], transfers: 0 })).toEqual({ success: true, message: "Work envelope" })
        expect(check({ edits: [attempt, puts[0], rollback, receipt], transfers: 0 }).message).toContain("rolls back carries no storage")
        expect(check({ edits: [attempt, rollback, receipt], transfers: 1 }).message).toContain("rolls back carries no transfer")
    })

    it("refuses a payment submitted by anyone but the payer's account", () => {
        const other = assertWorkEnvelope(
            { intent, authorizations: authorizations() },
            edits as never,
            1,
            DEFAULT_ATOMIC_WORK_LIMITS,
            ed25519SignerVerifier,
            "0x" + "99".repeat(32),
        )
        expect(other.success).toBe(false)
        expect(other.message).toContain("not the payer")
    })

    it("lets a replay through on identity alone", () => {
        expect(check({ env: { intent }, edits: [{ ...attempt, attemptClass: "replay" }], transfers: 0 }).success).toBe(true)
    })

    it("refuses a replay that carries transfers", () => {
        const replay = check({ env: { intent }, edits: [{ ...attempt, attemptClass: "replay" }], transfers: 1 })
        expect(replay.success).toBe(false)
        expect(replay.message).toContain("carries no transfers")
    })
})
