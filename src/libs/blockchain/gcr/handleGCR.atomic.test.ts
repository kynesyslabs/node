import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import {
    ATOMIC_STORAGE_DOMAIN,
    deriveStorageAddress,
    storageValueDigest,
} from "@/libs/atomic-work/storageWrite"
import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"
import { getSharedState } from "@/utilities/sharedState"

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

function caches(): GCREntityCaches {
    return {
        accounts: new Map([
            ["0xaa", { pubkey: "0xaa", balance: 100n, nonce: 0 } as any],
            ["0xbb", { pubkey: "0xbb", balance: 5n, nonce: 0 } as any],
        ]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

function balance(account: string, operation: "add" | "remove", amount: bigint) {
    return { type: "balance", account, operation, amount, isRollback: false, txhash: "" }
}

function tx(hash: string, from: string, edits: unknown[]): any {
    // Not "native": the forged-edit guard re-derives native edits from the
    // signed body, which is not what these cases are about.
    return { hash, content: { type: "demoswork", from, from_ed25519_address: from, gcr_edits: edits } }
}

const state = getSharedState as any
let forks: unknown

beforeEach(() => {
    forks = state.forkConfig
    state.forkConfig = cloneDefaultForkConfig()
    state.forkConfig.atomicWork.activationHeight = 0
    // These cases hand-build their edits to exercise apply semantics; the
    // guard that regenerates edits from the signed body is exercised with
    // SDK-built transactions on the devnet.
    state.forkConfig.nonceEnforcement.activationHeight = null
    state.lastBlockNumber = 10
})

afterEach(() => {
    state.forkConfig = forks
})

const work = {
    attempt: { type: "work-attempt", workId: "w1", attemptId: "a1", canonicalBytesHash: "h1", isRollback: false, txhash: "" },
    slot: (expected = { state: "vacant", generation: 0 }) => ({
        type: "resource-slot-cas",
        resourceKey: "k1",
        expected,
        transition: "settle",
        workId: "w1",
        conflictDigest: "c1",
        receiptCommitment: "r1",
        isRollback: false,
        txhash: "",
    }),
    receipt: {
        type: "work-receipt",
        workId: "w1",
        receiptCommitment: "r1",
        effectsRoot: "e1",
        inputHash: "i1",
        outputHash: "o1",
        isRollback: false,
        txhash: "",
    },
}

describe("HandleGCR.applyTransaction with a whole Work", () => {
    it("commits the transfer, the slot and the receipt together", async () => {
        const entities = caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x10", "0xaa", [
                work.attempt,
                balance("0xaa", "remove", 30n),
                balance("0xbb", "add", 30n),
                work.slot(),
                work.receipt,
            ]),
            false,
            false,
        )

        expect(result.success).toBe(true)
        expect(entities.accounts.get("0xbb")!.balance).toBe(35n)
        expect(entities.resourceSlots.get("k1")).toMatchObject({ state: "settled", workId: "w1" })
        expect(entities.atomicWorks.get("w1")).toMatchObject({ winnerAttemptId: "a1", receiptCommitment: "r1" })
    })

    it("commits nothing when the slot was already taken", async () => {
        const entities = caches()
        const taken = {
            state: "settled",
            generation: 0,
            workId: "w0",
            conflictDigest: "c0",
            receiptCommitment: "r0",
            resourceKey: "k1",
            txHash: "0x0",
            previous: null,
        } as any
        entities.resourceSlots.set("k1", taken)

        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x11", "0xaa", [
                work.attempt,
                balance("0xaa", "remove", 30n),
                balance("0xbb", "add", 30n),
                work.slot(),
                work.receipt,
            ]),
            false,
            false,
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("expected state vacant")
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
        expect(entities.resourceSlots.get("k1")).toBe(taken)
        expect(entities.atomicWorks.has("w1")).toBe(false)
    })

    it("undoes a committed Work on block rollback", async () => {
        const entities = caches()
        const edits = [work.attempt, balance("0xaa", "remove", 30n), balance("0xbb", "add", 30n), work.slot(), work.receipt]
        await HandleGCR.applyTransaction(entities, tx("0x12", "0xaa", structuredClone(edits)), false, false)

        const undone = await HandleGCR.applyTransaction(entities, tx("0x12", "0xaa", structuredClone(edits)), true, false)

        expect(undone.success).toBe(true)
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
        expect(entities.resourceSlots.get("k1")).toBeNull()
        expect(entities.atomicWorks.get("w1")).toBeNull()
    })

    it("writes storage with the Work and removes it again on block rollback", async () => {
        const entities = caches()
        const value = { delivered: true }
        const target = deriveStorageAddress(ATOMIC_STORAGE_DOMAIN, "0xaa", "result", "1")
        const put = {
            type: "storage-program-put",
            target,
            writer: "0xaa",
            name: "result",
            discriminator: "1",
            mode: "create-only",
            valueDigest: storageValueDigest(value),
            value,
            isRollback: false,
            txhash: "",
        }
        const edits = [work.attempt, put, work.slot(), work.receipt]

        const applied = await HandleGCR.applyTransaction(entities, tx("0x14", "0xaa", structuredClone(edits)), false, false)
        expect(applied.success).toBe(true)
        expect(entities.storagePrograms.get(target)?.data).toEqual(value)

        const undone = await HandleGCR.applyTransaction(entities, tx("0x14", "0xaa", structuredClone(edits)), true, false)
        expect(undone.success).toBe(true)
        expect(entities.storagePrograms.get(target)).toBeNull()
    })

    it("refuses a storage write signed by someone other than the writer", async () => {
        const entities = caches()
        const value = { delivered: true }
        const target = deriveStorageAddress(ATOMIC_STORAGE_DOMAIN, "0xbb", "result", "1")
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x15", "0xaa", [
                work.attempt,
                { type: "storage-program-put", target, writer: "0xbb", name: "result", discriminator: "1", mode: "create-only", valueDigest: storageValueDigest(value), value, isRollback: false, txhash: "" },
                work.slot(),
                work.receipt,
            ]),
            false,
            false,
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain("not by the sender")
        expect(entities.storagePrograms.has(target)).toBe(false)
    })

    it("refuses every Work edit while the fork is dormant", async () => {
        state.forkConfig.atomicWork.activationHeight = null
        const entities = caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x13", "0xaa", [work.attempt, work.slot(), work.receipt]),
            false,
            false,
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("not active")
        expect(entities.atomicWorks.has("w1")).toBe(false)
    })
})

describe("HandleGCR.applyTransaction with Work edits", () => {
    it("leaves every account untouched when a Work edit cannot be applied", async () => {
        const entities = caches()
        const payer = entities.accounts.get("0xaa")
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x1", "0xaa", [
                balance("0xaa", "remove", 30n),
                balance("0xbb", "add", 30n),
                // No attempt: the malformed Work sinks the whole set.
                { type: "work-receipt", workId: "w1", isRollback: false, txhash: "" },
            ]),
            false,
            false,
        )

        expect(result.success).toBe(false)
        expect(result.sideEffects).toEqual([])
        expect(entities.accounts.get("0xaa")).toBe(payer)
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
    })

    it("refuses a Work carrying an edit that persists outside block state, before applying anything", async () => {
        const entities = caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x2", "0xaa", [
                { ...work.attempt, workId: "w2" },
                balance("0xaa", "remove", 30n),
                { ...work.slot(), workId: "w2" },
                { ...work.receipt, workId: "w2" },
                { type: "validatorStake", isRollback: false, txhash: "" },
            ]),
            false,
            false,
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("validatorStake")
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
    })

    it("keeps the ordinary path for transactions without Work edits", async () => {
        const entities = caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x3", "0xaa", [balance("0xaa", "remove", 30n), balance("0xbb", "add", 30n)]),
            false,
            false,
        )

        expect(result.success).toBe(true)
        expect(entities.accounts.get("0xaa")!.balance).toBe(70n)
        expect(entities.accounts.get("0xbb")!.balance).toBe(35n)
    })
})

describe("HandleGCR.partitionIndependentTxs with Work edits", () => {
    const slot = (key: string, workId: string) => ({
        type: "resource-slot-cas",
        resourceKey: key,
        workId,
        isRollback: false,
        txhash: "",
    })

    it("serializes Works from different senders that contend for one slot", () => {
        const groups = HandleGCR.partitionIndependentTxs([
            tx("0xa", "0x01", [slot("same", "w1")]),
            tx("0xb", "0x02", [slot("same", "w2")]),
        ])
        expect(groups.length).toBe(1)
        expect(groups[0].map(t => t.hash)).toEqual(["0xa", "0xb"])
    })

    it("lets Works on different slots run in separate groups", () => {
        const groups = HandleGCR.partitionIndependentTxs([
            tx("0xa", "0x01", [slot("one", "w1")]),
            tx("0xb", "0x02", [slot("two", "w2")]),
        ])
        expect(groups.length).toBe(2)
    })

    it("groups attempts and receipts of one Work together", () => {
        const groups = HandleGCR.partitionIndependentTxs([
            tx("0xa", "0x01", [{ type: "work-attempt", workId: "w", isRollback: false, txhash: "" }]),
            tx("0xb", "0x02", [{ type: "work-receipt", workId: "w", isRollback: false, txhash: "" }]),
        ])
        expect(groups.length).toBe(1)
    })
})
