/**
 * Link contexts index the account's web2 bucket, a plain object. A name every
 * object inherits (constructor, toString, __proto__) used to pass the TLSN
 * lookup and reach apply, where indexing the bucket gave a function or the
 * prototype and the array calls on it threw. Each context is refused instead,
 * at admission and at apply, and the bucket and Object.prototype stay as they
 * were. Requests come from the SDK builders through the edit generator.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { Identities } from "@kynesyslabs/demosdk/abstraction"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

const tlsnotary = await import("@/libs/tlsnotary")
const realVerifyTLSNProof = tlsnotary.verifyTLSNProof
// A real presentation cannot be built here; the context rule is under test.
mock.module("@/libs/tlsnotary", () => ({
    ...tlsnotary,
    verifyTLSNProof: async () => ({ success: true, message: "verified" }),
}))

const { cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { getSharedState } = await import("@/utilities/sharedState")
const { demos, handMade, viaConfirm } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { generateGcrEdits } = await import("@/libs/blockchain/validation/generateGcrEdits")
const { applyTLSNIdentityAdd, applyTLSNIdentityRemove } = await import("./tlsnRoutines")
const { applyWeb2IdentityAdd, applyWeb2IdentityRemove } = await import("./web2Routines")
const { default: handleIdentityRequest } = await import(
    "@/libs/network/routines/transactions/handleIdentityRequest"
)

const identities = new Identities()
const SENDER: string = demos.getAddress()
const INHERITED = ["constructor", "__proto__", "toString"]
const UNKNOWN = "myspace"

let saved: { forkConfig: any; lastBlockNumber: number }
beforeEach(() => {
    saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = 500
})
afterEach(() => {
    getSharedState.forkConfig = saved.forkConfig
    getSharedState.lastBlockNumber = saved.lastBlockNumber
})
const carryoverAt = (height: number | null) => {
    getSharedState.forkConfig.identityCarryover.activationHeight = height
}

async function identityEdit(tx: any): Promise<any> {
    const edit = (await generateGcrEdits(tx)).find(e => e.type === "identity")
    if (!edit) throw new Error("no identity edit")
    return JSON.parse(JSON.stringify(edit))
}

const PROOF = { version: "0.1.0", data: "00" }
const tlsnAdd = (context: string) =>
    viaConfirm(() =>
        identities.addWeb2IdentityViaTLSN(
            demos,
            context as never,
            PROOF as never,
            "ab".repeat(32),
            { recv: [] } as never,
            [1, 2, 3],
            "alice",
            "7",
            undefined,
            { legacy: true },
        ),
    )
const tlsnRemove = (context: string) =>
    viaConfirm(() => identities.removeWeb2IdentityViaTLSN(demos, context as never, "alice"))
const web2Remove = (context: string) =>
    viaConfirm(() => identities.removeWeb2Identity(demos, { context, username: "alice" }))

const tlsnLink = { username: "alice", userId: "7", proof: PROOF, proofHash: "h", proofType: "tlsn", timestamp: 1 }
const gistLink = { username: "alice", userId: "7", proof: "p", proofHash: "h", timestamp: 1 }
const account = (context: string, link: Record<string, unknown>): any => ({
    pubkey: SENDER,
    identities: { web2: { [context]: [{ ...link }] } },
})

const prototypeKeys = () => Reflect.ownKeys(Object.prototype).map(String).sort()
const before = prototypeKeys()

/** The bucket gained no inherited name and Object.prototype is untouched. */
function untouched(gcr: any): void {
    const web2 = gcr.identities.web2
    for (const name of INHERITED) expect(Object.hasOwn(web2, name)).toBe(false)
    expect(Object.getPrototypeOf(web2)).toBe(Object.prototype)
    expect(prototypeKeys()).toEqual(before)
}

for (const [label, height] of [["before identityCarryover", null], ["under identityCarryover", 0]] as const) {
    describe(`TLSN link context, ${label}`, () => {
        beforeEach(() => carryoverAt(height))

        for (const context of [...INHERITED, UNKNOWN]) {
            it(`refuses ${context} on assign and remove without throwing`, async () => {
                const gcr = account("github", tlsnLink)
                const add = await applyTLSNIdentityAdd(await identityEdit(await tlsnAdd(context)), gcr)
                expect(add).toEqual({ success: false, message: `Unsupported TLSN context: ${context}` })

                const remove = await applyTLSNIdentityRemove(await identityEdit(await tlsnRemove(context)), gcr)
                expect(remove).toEqual({ success: false, message: `Unsupported TLSN context: ${context}` })
                expect(gcr.identities.web2.github).toHaveLength(1)
                untouched(gcr)
            })
        }

        it("links and unlinks a valid context", async () => {
            const gcr = { pubkey: SENDER, identities: { web2: {} } } as any
            const add = await applyTLSNIdentityAdd(await identityEdit(await tlsnAdd("github")), gcr)
            expect(add.success).toBe(true)
            expect(gcr.identities.web2.github.map((l: any) => [l.userId, l.proofType])).toEqual([["7", "tlsn"]])

            const remove = await applyTLSNIdentityRemove(await identityEdit(await tlsnRemove("github")), gcr)
            expect(remove.success).toBe(true)
            expect(gcr.identities.web2.github).toEqual([])
            untouched(gcr)
        })
    })

    describe(`web2 link context, ${label}`, () => {
        beforeEach(() => carryoverAt(height))

        for (const context of INHERITED) {
            it(`refuses ${context} on assign and remove without throwing`, async () => {
                const gcr = account("github", gistLink)
                const addEdit = {
                    account: SENDER,
                    data: { context, data: { ...gistLink, userId: "8" } },
                }
                const add = await applyWeb2IdentityAdd(addEdit, gcr)
                expect(add).toEqual({ success: false, message: `Unsupported web2 context: ${context}` })

                const remove = await applyWeb2IdentityRemove(await identityEdit(await web2Remove(context)), gcr)
                expect(remove).toEqual({ success: false, message: `Unsupported web2 context: ${context}` })
                expect(gcr.identities.web2.github).toHaveLength(1)
                untouched(gcr)
            })
        }

        it("finds no link under an unknown context", async () => {
            const gcr = account("github", gistLink)
            const remove = await applyWeb2IdentityRemove(await identityEdit(await web2Remove(UNKNOWN)), gcr)
            expect(remove).toEqual({ success: false, message: "Identity not found" })
            untouched(gcr)
        })

        it("unlinks a valid context", async () => {
            const gcr = account("github", gistLink)
            const remove = await applyWeb2IdentityRemove(await identityEdit(await web2Remove("github")), gcr)
            expect(remove.success).toBe(true)
            expect(gcr.identities.web2.github).toEqual([])
            untouched(gcr)
        })
    })
}

describe("admission of a link context", () => {
    for (const context of [...INHERITED, UNKNOWN]) {
        it(`refuses a remove under ${context}, as apply would`, async () => {
            const tlsn = await handleIdentityRequest(await tlsnRemove(context), SENDER)
            expect(tlsn).toEqual({ success: false, message: `Unsupported TLSN context: ${context}` })
            const web2 = await handleIdentityRequest(await web2Remove(context), SENDER)
            expect(web2).toEqual({ success: false, message: `Unsupported web2 context: ${context}` })
        })

        it(`refuses a TLSN assign under ${context} in the verifier`, async () => {
            const r = await realVerifyTLSNProof({
                context: context as never,
                proof: PROOF as never,
                recvHash: "ab".repeat(32),
                proofRanges: { recv: [] } as never,
                revealedRecv: [1, 2, 3],
                username: "alice",
                userId: "7",
            })
            expect(r).toEqual({ success: false, message: `Unsupported TLSN context: ${context}` })
        })
    }

    it("refuses a context that is not a string", async () => {
        const tx = await handMade("identity", {
            context: "tlsn",
            method: "tlsn_identity_remove",
            payload: { context: ["github"], username: "alice" },
        })
        expect(await handleIdentityRequest(tx, SENDER)).toEqual({
            success: false,
            message: "Unsupported TLSN context: github",
        })
    })

    it("admits a remove under a valid context", async () => {
        for (const tx of [await tlsnRemove("github"), await web2Remove("twitter"), await web2Remove("domain")]) {
            expect(await handleIdentityRequest(tx, SENDER)).toEqual({ success: true, message: "Identity removed" })
        }
    })
})
