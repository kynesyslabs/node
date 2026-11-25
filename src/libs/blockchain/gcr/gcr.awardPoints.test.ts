/**
 * The award RPC returns "Points awarded" for a transaction it queued. Once
 * editBinding is active peers drop an award not signed by the genesis award
 * signer, so a node that cannot sign one must refuse before creating it.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const tip = 100
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => tip },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))

import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

const { default: GCR } = await import("./gcr")
const { default: HandleGCR } = await import("./handleGCR")
const { default: Mempool } = await import("../mempool")

const SIGNER = "0x" + "5d".repeat(32)
const OTHER = "0x" + "6e".repeat(32)
const TARGET = "0x" + "7f".repeat(32)

let created = 0
let queued = 0
let savedForks: ForkConfigByName
const original = {
    create: (GCR as any).createAwardPointsTransaction,
    prepare: HandleGCR.prepareEntities,
    apply: HandleGCR.applyTransaction,
    add: (Mempool as any).addTransactionWithLock,
}

function awardTx(from: string) {
    return {
        hash: "ab".repeat(32),
        content: {
            type: "identity",
            from,
            from_ed25519_address: from,
            to: from,
            amount: 0,
            nonce: 1,
            data: ["awardPoints", [{ address: TARGET, points: 10 }]],
            gcr_edits: [
                { type: "identity", context: "points", isRollback: false, operation: "add", account: TARGET, amount: 10, date: "2026-10-27T10:00:00.000Z", txhash: "" },
            ],
        },
    }
}

// The shared state serves the key from its prototype; an own property would
// outlive this file's tests and be read by every later one.
const ownKey = Object.getOwnPropertyDescriptor(getSharedState, "publicKeyHex")

function nodeSignsWith(key: string) {
    Object.defineProperty(getSharedState, "publicKeyHex", { get: () => key, configurable: true })
}

function restoreNodeKey() {
    if (ownKey) Object.defineProperty(getSharedState, "publicKeyHex", ownKey)
    else delete (getSharedState as any).publicKeyHex
}

beforeEach(() => {
    savedForks = getSharedState.forkConfig
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.editBinding.activationHeight = 0
    ;(getSharedState as any)._genesisSudoPubkey = SIGNER
    created = 0
    queued = 0
    ;(GCR as any).createAwardPointsTransaction = async () => {
        created++
        return awardTx(getSharedState.publicKeyHex)
    }
    ;(HandleGCR as any).prepareEntities = async () => ({})
    ;(HandleGCR as any).applyTransaction = async () => ({ success: true })
    ;(Mempool as any).addTransactionWithLock = async () => {
        queued++
        return { confirmationBlock: 101 }
    }
})

afterEach(() => {
    restoreNodeKey()
    getSharedState.forkConfig = savedForks
    ;(getSharedState as any)._genesisSudoPubkey = null
    ;(GCR as any).createAwardPointsTransaction = original.create
    Object.assign(HandleGCR, { prepareEntities: original.prepare, applyTransaction: original.apply })
    ;(Mempool as any).addTransactionWithLock = original.add
})

const award = () => GCR.awardPoints([{ address: TARGET, points: 10 } as never], "weeklyChallenge")

describe("GCR.awardPoints naming a points bucket", () => {
    const bucketed = (bucket: unknown) => GCR.awardPoints([{ address: TARGET, points: 10 } as never], bucket as string)

    it("refuses a call that names no bucket, and says which ones exist", async () => {
        nodeSignsWith(SIGNER)
        for (const missing of [undefined, null]) {
            const out = await bucketed(missing)
            expect(out.success).toBe(false)
            expect(out.error).toContain("bucket is required")
            expect(out.error).toContain("\"weeklyChallenge\"")
            expect(out.error).toContain("\"validatorRewards\"")
        }
        expect(created).toBe(0)
        expect(queued).toBe(0)
    })

    it("names the options when the bucket is unknown, and says why validatorRewards is refused before the fork", async () => {
        nodeSignsWith(SIGNER)
        const unknown = await bucketed("referrals")
        expect(unknown.error).toContain("unknown bucket \"referrals\"")
        expect(unknown.error).toContain("\"weeklyChallenge\"")
        expect(unknown.error).toContain("\"validatorRewards\"")
        const early = await bucketed("validatorRewards")
        expect(early.error).toContain("fork is not active")
        expect(early.error).toContain("\"weeklyChallenge\"")
        expect(created).toBe(0)
    })

    it("builds an ordinary award with no bucket when weeklyChallenge is named", async () => {
        nodeSignsWith(SIGNER)
        let seen: unknown = "unset"
        ;(GCR as any).createAwardPointsTransaction = async (_accounts: unknown, bucket: unknown) => {
            seen = bucket
            return awardTx(getSharedState.publicKeyHex)
        }
        expect(await bucketed("weeklyChallenge")).toMatchObject({ success: true })
        expect(seen).toBeUndefined()
    })

    it("refuses before creating anything while validatorRewards is dormant", async () => {
        nodeSignsWith(SIGNER)
        expect(await bucketed("validatorRewards")).toMatchObject({ success: false })
        expect(created).toBe(0)
        expect(queued).toBe(0)
    })

    it("refuses an unknown bucket under the fork, and passes validatorRewards on to the transaction", async () => {
        getSharedState.forkConfig.validatorRewards.activationHeight = 0
        nodeSignsWith(SIGNER)
        expect(await bucketed("referrals")).toMatchObject({ success: false })
        expect(created).toBe(0)

        let seen: unknown
        ;(GCR as any).createAwardPointsTransaction = async (_accounts: unknown, bucket: unknown) => {
            seen = bucket
            return awardTx(getSharedState.publicKeyHex)
        }
        expect(await bucketed("validatorRewards")).toMatchObject({ success: true })
        expect(seen).toBe("validatorRewards")
        expect(queued).toBe(1)
    })
})

describe("the award transaction the node builds", () => {
    const { verifyAdmissionEdits } = require("../validation/editBinding")
    const { default: txValidatorPool } = require("../validation/txValidatorPool")
    const lookups = ["getAddressesByWeb2Usernames", "getAddressesByNativeAddresses", "getAddressesByXmAccounts"]
    const saved: Record<string, unknown> = {}
    let pool: unknown

    beforeEach(() => {
        getSharedState.forkConfig.validatorRewards.activationHeight = 0
        nodeSignsWith(SIGNER)
        ;(GCR as any).createAwardPointsTransaction = original.create
        for (const name of lookups) {
            saved[name] = (GCR as any)[name]
            ;(GCR as any)[name] = async () => (name === "getAddressesByNativeAddresses" ? { [TARGET]: TARGET } : {})
        }
        pool = txValidatorPool.getInstance
        txValidatorPool.getInstance = () => ({ sign: async () => ({ signature: new Uint8Array(64) }) })
    })

    afterEach(() => {
        for (const name of lookups) (GCR as any)[name] = saved[name]
        txValidatorPool.getInstance = pool
    })

    const build = (bucket?: string) =>
        (GCR as any).createAwardPointsTransaction([{ address: TARGET, points: 10 }], bucket)

    it("names the validatorRewards bucket in its data and in every edit, and passes admission", async () => {
        const tx = await build("validatorRewards")
        expect(tx.content.data[2]).toBe("validatorRewards")
        expect(tx.content.gcr_edits.map((e: any) => e.bucket)).toEqual(["validatorRewards"])
        expect(await verifyAdmissionEdits(tx)).toEqual({ ok: true })
    })

    it("carries no bucket anywhere for an ordinary award, and passes admission", async () => {
        const tx = await build()
        expect(tx.content.data).toHaveLength(2)
        expect(tx.content.gcr_edits).toHaveLength(1)
        expect("bucket" in tx.content.gcr_edits[0]).toBe(false)
        expect(await verifyAdmissionEdits(tx)).toEqual({ ok: true })
    })
})

describe("GCR.awardPoints behind the editBinding fork", () => {
    it("queues the award when the node signs with the genesis award signer", async () => {
        nodeSignsWith(SIGNER)
        expect(await award()).toMatchObject({ success: true, message: "Points awarded" })
        expect(queued).toBe(1)
    })

    it("fails before creating anything when the node signs with another key", async () => {
        nodeSignsWith(OTHER)
        const out = await award()
        expect(out.success).toBe(false)
        expect(out.error).toContain("does not sign with the genesis award signer")
        expect(created).toBe(0)
        expect(queued).toBe(0)
    })

    it("fails when genesis names no award signer", async () => {
        nodeSignsWith(SIGNER)
        ;(getSharedState as any)._genesisSudoPubkey = null
        const out = await award()
        expect(out.success).toBe(false)
        expect(out.error).toContain("names no award signer")
        expect(created).toBe(0)
    })

    it("runs the admission check on the transaction it created before queueing it", async () => {
        nodeSignsWith(SIGNER)
        ;(GCR as any).createAwardPointsTransaction = async () => {
            created++
            const tx = awardTx(SIGNER)
            tx.content.gcr_edits.push({ type: "identity", context: "points", isRollback: false, operation: "add", account: OTHER, amount: 1_000_000, date: "2026-10-27T10:00:00.000Z", txhash: "" })
            return tx
        }
        const out = await award()
        expect(out.success).toBe(false)
        expect(created).toBe(1)
        expect(queued).toBe(0)
    })

    it("behaves as before while the fork is dormant", async () => {
        getSharedState.forkConfig.editBinding.activationHeight = null
        ;(getSharedState as any)._genesisSudoPubkey = null
        nodeSignsWith(OTHER)
        expect(await award()).toMatchObject({ success: true })
        expect(queued).toBe(1)
    })
})
