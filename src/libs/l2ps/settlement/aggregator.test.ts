/**
 * The entry node's settlement loop, with the planner, prover, mempool and
 * chain replaced by in-memory fakes. Transfers are real: commitments come
 * from encoding.ts and signatures from fixed-seed keys.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test"

/** Everything logged above debug. */
const loud: string[] = []
const shout = (...args: unknown[]) => {
    loud.push(args.map(String).join(" "))
}
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug() {}, info: shout, warning: shout, warn: shout, error: shout, only: shout, custom() {} },
}))

import { L2PS_STATUS } from "@/libs/blockchain/l2ps_mempool"
import type { TxStatus } from "@/libs/blockchain/chainTypes"
import { fieldToHex } from "./encoding"
import { SettlementAggregator, type HistoryStatus, type SettlementDeps } from "./aggregator"
import { openSettlementTransfer } from "./transfer"
import type { DecryptedTransfer, SettlementPlan } from "./types"
import type { SettlementRecord } from "./validation"
import { UID, innerTx, key, netChanges, signedTransfer } from "./__fixtures__/settlementKit"

const ALICE = key(1)
const BOB = key(2)
const CAROL = key(3)
const DAVE = key(4)
const FEE = 3n

interface Row {
    hash: string
    original_hash: string
    l2ps_uid: string
    encrypted_tx: unknown
    status: string
}

let rows: Map<string, Row>
let tip: Map<string, { balance: bigint; nonce: bigint }>
let statuses: Map<string, TxStatus>
let submitted: { l1: string; record: SettlementRecord; rows: string[] }[]
let history: { hash: string; status: HistoryStatus; message: string; l1?: string }[]
let historyBatch: Map<string, string>
let head: number
let now: number
let proveCalls: number
let proverFails: boolean
let submitRefuses: boolean
let minimumFee: bigint

/** A planner that takes transfers in order while the sender can pay and the nonce is next. */
function plan(transfers: DecryptedTransfer[], balances: Map<string, bigint>, nonces: Map<string, bigint>): SettlementPlan {
    const bal = new Map(balances)
    const next = new Map<string, bigint>()
    const taken: DecryptedTransfer[] = []
    const deferred: SettlementPlan["deferred"] = []
    for (const t of transfers) {
        const nonce = next.get(t.from) ?? (nonces.get(t.from) ?? 0n) + 1n
        const cost = t.amount + t.fee
        if (taken.length >= 10 || t.nonce !== nonce || (bal.get(t.from) ?? 0n) < cost) {
            deferred.push({ transfer: t, reason: "not now" })
            continue
        }
        bal.set(t.from, (bal.get(t.from) ?? 0n) - cost)
        bal.set(t.to, (bal.get(t.to) ?? 0n) + t.amount)
        next.set(t.from, nonce + 1n)
        taken.push(t)
    }
    return { transfers: taken, deferred, changes: netChanges(taken), balancesBefore: new Map(balances) }
}

function deps(): SettlementDeps {
    return {
        subnets: async status => ([...rows.values()].some(r => r.status === status) ? [UID] : []),
        rows: async (_uid, status, limit) => [...rows.values()].filter(r => r.status === status).slice(0, limit) as any,
        open: async (_uid, row: any) => openSettlementTransfer(row.encrypted_tx, row.hash),
        tip: async accounts => {
            const out = new Map<string, { balance: bigint; nonce: bigint }>()
            for (const a of accounts) out.set(a, tip.get(a) ?? { balance: 0n, nonce: 0n })
            return out
        },
        minimumFee: async () => minimumFee,
        plan,
        prove: async () => {
            proveCalls++
            if (proverFails) throw new Error("prover subprocess exited")
            return { proof: { id: `proof${proveCalls}` }, publicSignals: [] }
        },
        submit: async (_uid, record, batchRows) => {
            if (submitRefuses) return null
            const l1 = `l1_${submitted.length + 1}`
            submitted.push({ l1, record, rows: batchRows.map(r => r.hash) })
            statuses.set(l1, { state: "pending" })
            return l1
        },
        status: async hash => statuses.get(hash) ?? { state: "unknown" },
        setRows: async (hashes, status) => {
            for (const h of hashes) rows.get(h)!.status = status
        },
        history: async (hash, status, message, l1) => {
            history.push({ hash, status, message, l1 })
            if (l1) historyBatch.set(hash, l1)
        },
        historyBatchHash: async (_uid, row: any) => historyBatch.get(row.hash) ?? null,
        head: () => head,
        now: () => now,
    }
}

const LIMITS = {
    minBatchSize: 1,
    maxBatchesPerCycle: 3,
    queueWindow: 100,
    expiryBlocks: 6,
    proverBackoffMs: 5_000,
    proverBackoffMaxMs: 60_000,
}

function queue(t: DecryptedTransfer, status: string = L2PS_STATUS.EXECUTED, inner: unknown = innerTx(t)) {
    rows.set(t.txHash, { hash: t.txHash, original_hash: `orig_${t.txHash}`, l2ps_uid: UID, encrypted_tx: inner, status })
}

const pay = (from: typeof ALICE, to: string, amount: bigint, nonce: bigint) =>
    signedTransfer({ from, to, amount, fee: FEE, nonce })
const statusOf = (t: DecryptedTransfer) => rows.get(t.txHash)!.status

beforeEach(() => {
    loud.length = 0
    rows = new Map()
    tip = new Map([
        [ALICE.account, { balance: 100n, nonce: 4n }],
        [BOB.account, { balance: 50n, nonce: 0n }],
        [CAROL.account, { balance: 0n, nonce: 0n }],
    ])
    statuses = new Map()
    submitted = []
    history = []
    historyBatch = new Map()
    head = 100
    now = 1_000_000
    proveCalls = 0
    proverFails = false
    submitRefuses = false
    minimumFee = FEE
})

describe("SettlementAggregator", () => {
    it("submits a proven settlement record and marks its transfers batched", async () => {
        const t1 = pay(ALICE, BOB.account, 10n, 5n)
        const t2 = pay(ALICE, CAROL.account, 1n, 6n)
        queue(t1)
        queue(t2)
        const agg = new SettlementAggregator(deps(), LIMITS)

        expect(await agg.cycle()).toEqual({ submitted: 1, transfers: 2 })

        expect(submitted).toHaveLength(1)
        const { record } = submitted[0]
        expect(record.version).toBe(1)
        expect(record.transfers).toEqual(
            [t1, t2].map(t => ({
                commitment: fieldToHex(t.commitment),
                signer: ALICE.account,
                nonce: t.nonce.toString(),
                fee: "3",
                signature: t.signature,
            })),
        )
        expect(record.changes).toEqual(netChanges([t1, t2]).map(c => ({ account: c.account, delta: c.delta.toString() })))
        expect(record.proof).toEqual({ id: "proof1" })
        expect(statusOf(t1)).toBe(L2PS_STATUS.BATCHED)
        expect(history.filter(h => h.status === "batched").map(h => h.l1)).toEqual(["l1_1", "l1_1"])
    })

    it("drops a transfer whose nonce L1 already spent, and an old-format one, with a history status", async () => {
        const spent = pay(ALICE, BOB.account, 10n, 4n)
        const old = pay(BOB, CAROL.account, 1n, 1n)
        const inner = innerTx(old) as any
        delete inner.content.data[1].settlement
        queue(spent)
        queue(old, L2PS_STATUS.EXECUTED, inner)

        await new SettlementAggregator(deps(), LIMITS).cycle()

        expect(submitted).toHaveLength(0)
        expect(statusOf(spent)).toBe(L2PS_STATUS.FAILED)
        expect(statusOf(old)).toBe(L2PS_STATUS.FAILED)
        expect(history.find(h => h.hash === spent.txHash)).toMatchObject({ status: "failed" })
        expect(history.find(h => h.hash === spent.txHash)!.message).toContain("already spent on L1")
        expect(history.find(h => h.hash === old.txHash)!.message).toContain("old-format")
    })

    it("drops a transfer whose fee is below the native transfer fee now, so no doomed batch is proved", async () => {
        const cheap = pay(ALICE, BOB.account, 10n, 5n)
        queue(cheap)
        minimumFee = FEE + 1n

        await new SettlementAggregator(deps(), LIMITS).cycle()

        expect(proveCalls).toBe(0)
        expect(submitted).toHaveLength(0)
        expect(statusOf(cheap)).toBe(L2PS_STATUS.FAILED)
        expect(history.find(h => h.hash === cheap.txHash)!.message).toContain("below the native transfer fee")
        // The reason names the fee, which only subnet members may see.
        expect(loud.join("\n")).not.toContain(`fee ${FEE}`)
        expect(loud.join("\n")).toContain(cheap.txHash.slice(0, 16))
    })

    it("keeps a transfer the planner defers queued", async () => {
        const ok = pay(ALICE, BOB.account, 10n, 5n)
        const tooMuch = pay(CAROL, BOB.account, 10n, 1n)
        queue(ok)
        queue(tooMuch)

        await new SettlementAggregator(deps(), LIMITS).cycle()

        expect(statusOf(ok)).toBe(L2PS_STATUS.BATCHED)
        expect(statusOf(tooMuch)).toBe(L2PS_STATUS.EXECUTED)
        expect(history.some(h => h.hash === tooMuch.txHash)).toBe(false)
    })

    it("leaves transfers queued when proving fails and backs off instead of retrying every cycle", async () => {
        const t = pay(ALICE, BOB.account, 10n, 5n)
        queue(t)
        proverFails = true
        const agg = new SettlementAggregator(deps(), LIMITS)

        await agg.cycle()
        await agg.cycle()
        expect(proveCalls).toBe(1)
        expect(statusOf(t)).toBe(L2PS_STATUS.EXECUTED)

        now += 5_000
        await agg.cycle()
        expect(proveCalls).toBe(2)
        // The second failure doubles the pause.
        now += 5_000
        await agg.cycle()
        expect(proveCalls).toBe(2)

        proverFails = false
        now += 5_000
        await agg.cycle()
        expect(proveCalls).toBe(3)
        expect(statusOf(t)).toBe(L2PS_STATUS.BATCHED)
    })

    it("confirms the transfers of a batch that landed and keeps its accounts locked until the tip passes it", async () => {
        const first = pay(ALICE, BOB.account, 10n, 5n)
        queue(first)
        const agg = new SettlementAggregator(deps(), LIMITS)
        await agg.cycle()

        const next = pay(ALICE, CAROL.account, 1n, 6n)
        queue(next)
        await agg.cycle()
        expect(statusOf(next)).toBe(L2PS_STATUS.EXECUTED)
        expect(proveCalls).toBe(1)

        statuses.set("l1_1", { state: "included", blockNumber: 101 })
        head = 101
        await agg.cycle()
        expect(statusOf(first)).toBe(L2PS_STATUS.CONFIRMED)
        expect(history.find(h => h.hash === first.txHash && h.status === "confirmed")!.l1).toBe("l1_1")
        // The tip may not show block 101 yet.
        expect(statusOf(next)).toBe(L2PS_STATUS.EXECUTED)

        head = 102
        tip.set(ALICE.account, { balance: 87n, nonce: 5n })
        await agg.cycle()
        expect(statusOf(next)).toBe(L2PS_STATUS.BATCHED)
        expect(agg.inFlightBatches().has("l1_1")).toBe(false)
    })

    it("re-plans and re-proves the transfers of a batch L1 included as failed", async () => {
        const t = pay(ALICE, BOB.account, 10n, 5n)
        queue(t)
        const agg = new SettlementAggregator(deps(), LIMITS)
        await agg.cycle()

        statuses.set("l1_1", { state: "failed", blockNumber: 101, code: "TX_FAILED" })
        head = 101
        await agg.cycle()

        expect(history.find(h => h.status === "pending")!.message).toContain("L1 batch failed")
        expect(proveCalls).toBe(2)
        expect(submitted.map(s => s.l1)).toEqual(["l1_1", "l1_2"])
        expect(statusOf(t)).toBe(L2PS_STATUS.BATCHED)
    })

    it("re-queues a batch the chain never saw once it is past the window", async () => {
        const t = pay(ALICE, BOB.account, 10n, 5n)
        queue(t)
        const agg = new SettlementAggregator(deps(), LIMITS)
        await agg.cycle()
        statuses.delete("l1_1")

        head = 106
        await agg.cycle()
        expect(submitted).toHaveLength(1)

        head = 107
        await agg.cycle()
        expect(submitted).toHaveLength(2)
    })

    it("plans a second batch in the same cycle only over accounts the first does not touch", async () => {
        const many = Array.from({ length: 10 }, (_, i) => pay(ALICE, BOB.account, 1n, 5n + BigInt(i)))
        const overlap = pay(BOB, CAROL.account, 1n, 1n)
        tip.set(DAVE.account, { balance: 10n, nonce: 0n })
        const disjoint = pay(DAVE, "0x" + "ee".repeat(32), 1n, 1n)
        for (const t of [...many, overlap, disjoint]) queue(t)

        await new SettlementAggregator(deps(), LIMITS).cycle()

        expect(submitted).toHaveLength(2)
        expect(submitted[0].rows).toEqual(many.map(t => t.txHash))
        expect(submitted[1].rows).toEqual([disjoint.txHash])
        expect(statusOf(overlap)).toBe(L2PS_STATUS.EXECUTED)
    })

    it("leaves the queue as it was when the mempool refuses the batch", async () => {
        const t = pay(ALICE, BOB.account, 10n, 5n)
        queue(t)
        submitRefuses = true

        await new SettlementAggregator(deps(), LIMITS).cycle()

        expect(statusOf(t)).toBe(L2PS_STATUS.EXECUTED)
        expect(history).toHaveLength(0)
    })

    it("after a restart follows batched rows through their history and re-queues the rest", async () => {
        const tracked = pay(ALICE, BOB.account, 10n, 5n)
        const orphan = pay(BOB, CAROL.account, 1n, 1n)
        queue(tracked, L2PS_STATUS.BATCHED)
        queue(orphan, L2PS_STATUS.BATCHED)
        historyBatch.set(tracked.txHash, "l1_before")
        statuses.set("l1_before", { state: "included", blockNumber: 99 })

        await new SettlementAggregator(deps(), LIMITS).cycle()

        expect(statusOf(tracked)).toBe(L2PS_STATUS.CONFIRMED)
        // The orphan went back to the queue and was batched again.
        expect(statusOf(orphan)).toBe(L2PS_STATUS.BATCHED)
        expect(submitted[0].rows).toEqual([orphan.txHash])
    })
})
