import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { declareNativeOperationKinds } from "@/libs/atomic-work/effectBoundary"
import { registerAtomicWorkProfile } from "@/libs/atomic-work/profile"
import {
    ATOMIC_STORAGE_DOMAIN,
    deriveStorageAddress,
    storageValueDigest,
} from "@/libs/atomic-work/storageWrite"
import { intentBytesHash } from "@/libs/atomic-work/workEnvelope"
import { computeWorkId } from "@/libs/atomic-work/workId"
import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"
import { getSharedState } from "@/utilities/sharedState"

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

const DOMAINS = {
    workId: "test-work:v1:",
    authorization: "test-auth:v1:",
    operationReceipt: "test-op-receipt:v1:",
    workReceipt: "test-receipt:v1:",
}

// Two small profiles so each case can declare exactly the effects it carries.
// Authorization is covered with real signatures in the envelope tests.
const op = (operationId: string, kind: string, dependsOn: string[] = []) => ({
    operationId,
    kind,
    dependsOn,
    requiredRoles: [] as string[],
})
const GRAPHS = {
    "test-pay-v1": [op("claim", "resource-slot-cas"), op("pay", "native-dem-transfer", ["claim"])],
    "test-store-v1": [op("record", "storage-program-put"), op("claim", "resource-slot-cas", ["record"])],
}

beforeAll(() => {
    declareNativeOperationKinds()
    for (const [name, operationGraph] of Object.entries(GRAPHS)) {
        registerAtomicWorkProfile({
            name,
            operationGraph: operationGraph.map(({ kind, ...o }) => ({ ...o, kinds: [kind] })),
            roles: [],
            domains: DOMAINS,
            verifyAuthorizations: () => {},
        })
    }
})

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

/** One Work under `profile`, with ids derived from its intent. */
function work(profile: keyof typeof GRAPHS, seed: string) {
    const intent = {
        profile,
        seed,
        operations: GRAPHS[profile].map(o => ({ ...o })),
    }
    const workId = computeWorkId(intent, DOMAINS.workId)
    return {
        intent,
        workId,
        attempt: (over: Record<string, unknown> = {}) => ({
            type: "work-attempt",
            workId,
            attemptId: `${seed}-a1`,
            canonicalBytesHash: intentBytesHash(intent),
            isRollback: false,
            txhash: "",
            ...over,
        }),
        slot: (key = "k1", expected = { state: "vacant", generation: 0 }) => ({
            type: "resource-slot-cas",
            resourceKey: key,
            expected,
            transition: "settle",
            workId,
            conflictDigest: "c1",
            isRollback: false,
            txhash: "",
        }),
    }
}

function workTx(
    hash: string,
    from: string,
    w: ReturnType<typeof work>,
    edits: unknown[],
    transfers: unknown[] = [],
): any {
    return {
        hash,
        content: {
            type: "atomicWork",
            from,
            from_ed25519_address: from,
            data: ["atomicWork", { intent: w.intent, authorizations: [], transfers }],
            gcr_edits: edits,
        },
    }
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

// The block these Works are applied in: height 11, consensus time 1.8e9 s.
const CLOCK = { height: 11, timestampSec: 1_800_000_000 }

// The envelope every Work transaction ends with: gas, then the nonce spend.
const envelope = () => [
    balance("0xaa", "remove", 1n),
    { type: "nonce", account: "0xaa", operation: "add", amount: 1, isRollback: false, txhash: "" },
]

const payWork = (seed = "w1") => {
    const w = work("test-pay-v1", seed)
    const edits: unknown[] = [
        w.attempt(),
        w.slot(),
        balance("0xaa", "remove", 30n),
        balance("0xbb", "add", 30n),
        ...envelope(),
    ]
    return { w, edits, transfers: [{ to: "0xbb", amount: "30" }] }
}

describe("HandleGCR.applyTransaction with a whole Work", () => {
    it("commits the transfer, the slot and the receipt together", async () => {
        const entities = caches()
        const { w, edits, transfers } = payWork()
        const result = await HandleGCR.applyTransaction(entities, workTx("0x10", "0xaa", w, edits, transfers), false, false, CLOCK)

        expect(result.success).toBe(true)
        expect(entities.accounts.get("0xbb")!.balance).toBe(35n)
        expect(entities.resourceSlots.get("k1")).toMatchObject({ state: "settled", workId: w.workId })
        // The node built the receipt and put its commitment on the slot too.
        const record = entities.atomicWorks.get(w.workId)!
        expect(record.winnerAttemptId).toBe("w1-a1")
        expect(record.receiptCommitment).toMatch(/^[0-9a-f]{64}$/)
        expect(record.receipt).toMatchObject({ workId: w.workId, outcome: "committed", receiptCommitment: record.receiptCommitment })
        expect(entities.resourceSlots.get("k1")).toMatchObject({ receiptCommitment: record.receiptCommitment })
    })

    it("rolls back a Work that lost its slot, charging only its fee and nonce", async () => {
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
        const { w, edits, transfers } = payWork()

        const result = await HandleGCR.applyTransaction(entities, workTx("0x11", "0xaa", w, edits, transfers), false, false, CLOCK)

        // Included and charged, with none of its effects.
        expect(result.success).toBe(true)
        expect(result.message).toContain("rolled back")
        expect(result.message).toContain("expected state vacant")
        expect(entities.accounts.get("0xaa")!.balance).toBe(99n)
        expect(entities.accounts.get("0xaa")!.nonce).toBe(1)
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
        expect(entities.resourceSlots.get("k1")).toBe(taken)
        expect(entities.atomicWorks.has(w.workId)).toBe(false)
    })

    it("refuses at admission, charging nothing, a Work that would roll back", async () => {
        const entities = caches()
        entities.resourceSlots.set("k1", { state: "settled", generation: 0, workId: "w0", conflictDigest: "c0", receiptCommitment: "r0", resourceKey: "k1", txHash: "0x0", previous: null } as any)
        const { w, edits, transfers } = payWork()

        const simulated = await HandleGCR.applyTransaction(entities, workTx("0x16", "0xaa", w, edits, transfers), false, true)
        expect(simulated.success).toBe(false)
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
    })

    it("undoes only the fee and nonce of a rolled-back Work on block rollback", async () => {
        const entities = caches()
        entities.resourceSlots.set("k1", { state: "settled", generation: 0, workId: "w0", conflictDigest: "c0", receiptCommitment: "r0", resourceKey: "k1", txHash: "0x0", previous: null } as any)
        const { w, edits, transfers } = payWork()
        await HandleGCR.applyTransaction(entities, workTx("0x17", "0xaa", w, structuredClone(edits), transfers), false, false, CLOCK)
        expect(entities.accounts.get("0xaa")!.balance).toBe(99n)

        const undone = await HandleGCR.applyTransaction(entities, workTx("0x17", "0xaa", w, structuredClone(edits), transfers), true, false)
        expect(undone.success).toBe(true)
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
        expect(entities.accounts.get("0xaa")!.nonce).toBe(0)
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
    })

    it("lets a replay spend its nonce without paying a fee again", async () => {
        const entities = caches()
        const { w, edits, transfers } = payWork()
        await HandleGCR.applyTransaction(entities, workTx("0x18", "0xaa", w, edits, transfers), false, false, CLOCK)
        const paid = entities.accounts.get("0xaa")!.balance

        const replay = await HandleGCR.applyTransaction(
            entities,
            workTx("0x19", "0xaa", w, [w.attempt({ attemptId: "w1-replay", attemptClass: "replay" }), ...envelope()], []),
            false,
            false,
            CLOCK,
        )
        expect(replay.success).toBe(true)
        expect(entities.accounts.get("0xaa")!.balance).toBe(paid)
        expect(entities.accounts.get("0xaa")!.nonce).toBe(2)
    })

    it("undoes a committed Work on block rollback", async () => {
        const entities = caches()
        const { w, edits, transfers } = payWork()
        await HandleGCR.applyTransaction(entities, workTx("0x12", "0xaa", w, structuredClone(edits), transfers), false, false, CLOCK)

        const undone = await HandleGCR.applyTransaction(entities, workTx("0x12", "0xaa", w, structuredClone(edits), transfers), true, false, CLOCK)

        expect(undone.success).toBe(true)
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
        expect(entities.resourceSlots.get("k1")).toBeNull()
        expect(entities.atomicWorks.get(w.workId)).toBeNull()
    })

    it("writes storage with the Work and removes it again on block rollback", async () => {
        const entities = caches()
        const w = work("test-store-v1", "s1")
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
        const edits = [w.attempt(), put, w.slot()]

        const applied = await HandleGCR.applyTransaction(entities, workTx("0x14", "0xaa", w, structuredClone(edits)), false, false, CLOCK)
        expect(applied.success).toBe(true)
        expect(entities.storagePrograms.get(target)?.data).toEqual(value)

        const undone = await HandleGCR.applyTransaction(entities, workTx("0x14", "0xaa", w, structuredClone(edits)), true, false, CLOCK)
        expect(undone.success).toBe(true)
        expect(entities.storagePrograms.get(target)).toBeNull()
    })

    it("refuses a storage write signed by someone other than the writer", async () => {
        const entities = caches()
        const w = work("test-store-v1", "s2")
        const value = { delivered: true }
        const target = deriveStorageAddress(ATOMIC_STORAGE_DOMAIN, "0xbb", "result", "1")
        const put = { type: "storage-program-put", target, writer: "0xbb", name: "result", discriminator: "1", mode: "create-only", valueDigest: storageValueDigest(value), value, isRollback: false, txhash: "" }

        const result = await HandleGCR.applyTransaction(entities, workTx("0x15", "0xaa", w, [w.attempt(), put, w.slot()]), false, false, CLOCK)

        expect(result.success).toBe(false)
        expect(result.message).toContain("not by the sender")
        expect(entities.storagePrograms.has(target)).toBe(false)
    })

    it("refuses every Work edit while the fork is dormant", async () => {
        state.forkConfig.atomicWork.activationHeight = null
        const entities = caches()
        const { w, edits, transfers } = payWork()
        const result = await HandleGCR.applyTransaction(entities, workTx("0x13", "0xaa", w, edits, transfers), false, false, CLOCK)

        expect(result.success).toBe(false)
        expect(result.message).toContain("not active")
        expect(entities.atomicWorks.has(w.workId)).toBe(false)
    })
})

describe("HandleGCR.applyTransaction judges deadlines by consensus time", () => {
    const timed = (window: Record<string, number>) => {
        const w = work("test-pay-v1", "t-" + JSON.stringify(window))
        Object.assign(w.intent, window)
        return work2(w)
    }
    // Rebuild the ids once the intent carries its window.
    const work2 = (w: ReturnType<typeof work>) => {
        const workId = computeWorkId(w.intent, DOMAINS.workId)
        const attempt = { ...w.attempt(), workId, canonicalBytesHash: intentBytesHash(w.intent) }
        const slot = { ...w.slot(), workId }
        return { w: { ...w, workId }, edits: [attempt, slot, balance("0xaa", "remove", 30n), balance("0xbb", "add", 30n)] }
    }
    const transfers = [{ to: "0xbb", amount: "30" }]

    it("stamps the receipt with the block's consensus time", async () => {
        const entities = caches()
        const { w, edits } = timed({ expiresAt: 1_800_000_000_000 + 1 })
        const result = await HandleGCR.applyTransaction(entities, workTx("0x30", "0xaa", w, edits, transfers), false, false, CLOCK)
        expect(result.success).toBe(true)
        expect(entities.atomicWorks.get(w.workId)!.receipt!.blockRef).toEqual({ height: "11", timestamp: 1_800_000_000_000 })
    })

    it("refuses a Work whose deadline passed before the block", async () => {
        const entities = caches()
        const { w, edits } = timed({ expiresAt: 1_800_000_000_000 - 1 })
        const result = await HandleGCR.applyTransaction(entities, workTx("0x31", "0xaa", w, edits, transfers), false, false, CLOCK)
        expect(result.success).toBe(false)
        expect(result.message).toContain("expired")
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
    })

    it("refuses a Work not yet valid at the block", async () => {
        const entities = caches()
        const { w, edits } = timed({ notBefore: 1_800_000_000_000 + 1 })
        const result = await HandleGCR.applyTransaction(entities, workTx("0x32", "0xaa", w, edits, transfers), false, false, CLOCK)
        expect(result.success).toBe(false)
        expect(result.message).toContain("not valid until")
    })

    it("refuses to execute a Work without a block to take the time from", async () => {
        const entities = caches()
        const { w, edits, transfers: t } = payWork()
        const result = await HandleGCR.applyTransaction(entities, workTx("0x33", "0xaa", w, edits, t), false, false)
        expect(result.success).toBe(false)
        expect(result.message).toContain("consensus block time")
    })
})

describe("HandleGCR.applyTransaction binds Work edits to their intent", () => {
    it("refuses Work edits outside an atomicWork transaction", async () => {
        const entities = caches()
        const { w, edits, transfers } = payWork()
        const tx = workTx("0x20", "0xaa", w, edits, transfers)
        tx.content.type = "demoswork"

        const result = await HandleGCR.applyTransaction(entities, tx, false, false, CLOCK)
        expect(result.success).toBe(false)
        expect(result.message).toContain("atomicWork transaction")
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
    })

    it("refuses a Work whose id is not derived from the intent it carries", async () => {
        const entities = caches()
        const { w, edits, transfers } = payWork()
        edits[0] = { ...(edits[0] as object), workId: "forged" }

        const result = await HandleGCR.applyTransaction(entities, workTx("0x21", "0xaa", w, edits, transfers), false, false, CLOCK)
        expect(result.success).toBe(false)
        expect(result.message).toContain("workId")
    })

    it("refuses a transfer the intent does not declare", async () => {
        const entities = caches()
        const { w, edits } = payWork()

        const result = await HandleGCR.applyTransaction(
            entities,
            workTx("0x22", "0xaa", w, edits, [{ to: "0xbb", amount: "30" }, { to: "0xbb", amount: "1" }]),
            false,
            false,
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain("transfer")
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
    })

    it("refuses a Work carrying an edit that persists outside block state, before applying anything", async () => {
        const entities = caches()
        const { w, edits, transfers } = payWork()
        edits.push({ type: "validatorStake", isRollback: false, txhash: "" })

        const result = await HandleGCR.applyTransaction(entities, workTx("0x23", "0xaa", w, edits, transfers), false, false, CLOCK)
        expect(result.success).toBe(false)
        expect(result.message).toContain("validatorStake")
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
    })

    it("keeps the ordinary path for transactions without Work edits", async () => {
        const entities = caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            { hash: "0x3", content: { type: "demoswork", from: "0xaa", from_ed25519_address: "0xaa", gcr_edits: [balance("0xaa", "remove", 30n), balance("0xbb", "add", 30n)] } } as any,
            false,
            false,
        )

        expect(result.success).toBe(true)
        expect(entities.accounts.get("0xaa")!.balance).toBe(70n)
        expect(entities.accounts.get("0xbb")!.balance).toBe(35n)
    })
})

describe("HandleGCR.partitionIndependentTxs with Work edits", () => {
    const slotTx = (hash: string, from: string, key: string, seed: string) => {
        const w = work("test-pay-v1", seed)
        return workTx(hash, from, w, [w.slot(key)])
    }

    it("serializes Works from different senders that contend for one slot", () => {
        const groups = HandleGCR.partitionIndependentTxs([slotTx("0xa", "0x01", "same", "w1"), slotTx("0xb", "0x02", "same", "w2")])
        expect(groups.length).toBe(1)
        expect(groups[0].map(t => t.hash)).toEqual(["0xa", "0xb"])
    })

    it("lets Works on different slots run in separate groups", () => {
        const groups = HandleGCR.partitionIndependentTxs([slotTx("0xa", "0x01", "one", "w1"), slotTx("0xb", "0x02", "two", "w2")])
        expect(groups.length).toBe(2)
    })

    it("groups every transaction of one Work together", () => {
        const w = work("test-pay-v1", "w1")
        const groups = HandleGCR.partitionIndependentTxs([
            workTx("0xa", "0x01", w, [w.attempt()]),
            workTx("0xb", "0x02", w, [{ ...w.attempt(), attemptId: "w1-a2", attemptClass: "replay" }]),
        ])
        expect(groups.length).toBe(1)
    })
})
