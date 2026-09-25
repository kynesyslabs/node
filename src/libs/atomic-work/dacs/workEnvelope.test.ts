import { beforeAll, describe, expect, it } from "bun:test"
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
intent.roleRoster = intent.roleRoster.map((r: any) => ({ ...r, signer: keys[r.role].hex }))
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
const put = { type: "storage-program-put" }
const slot = { type: "resource-slot-cas", workId }
const receipt = { type: "work-receipt", workId }
// The purchase graph writes three times, claims one slot and pays once.
const edits = [attempt, put, put, put, slot, receipt]

const check = (over: { env?: any; edits?: any[]; transfers?: number } = {}) =>
    assertWorkEnvelope(
        over.env ?? { intent, authorizations: authorizations() },
        (over.edits ?? edits) as never,
        over.transfers ?? 1,
        DEFAULT_ATOMIC_WORK_LIMITS,
        ed25519SignerVerifier,
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
        expect(check({ edits: [{ ...attempt, workId: "0".repeat(64) }, put, put, put, slot, receipt] }).success).toBe(false)
        expect(check({ edits: [{ ...attempt, canonicalBytesHash: "0".repeat(64) }, put, put, put, slot, receipt] }).success).toBe(false)
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
            [{ ...attempt, workId: didWorkId, canonicalBytesHash: intentBytesHash(didIntent) }, put, put, put, { ...slot, workId: didWorkId }, { ...receipt, workId: didWorkId }] as never,
            1,
            DEFAULT_ATOMIC_WORK_LIMITS,
            ed25519SignerVerifier,
        )
        expect(result.success).toBe(false)
    })

    it("refuses effects the intent does not declare", () => {
        expect(check({ edits: [attempt, put, put, slot, receipt] }).message).toContain("storage")
        expect(check({ transfers: 2 }).message).toContain("transfer")
        expect(check({ edits: [attempt, put, put, put, { ...slot, workId: "other" }, receipt] }).success).toBe(false)
    })

    it("lets a replay through on identity alone", () => {
        expect(check({ env: { intent }, edits: [{ ...attempt, attemptClass: "replay" }], transfers: 0 }).success).toBe(true)
    })
})
