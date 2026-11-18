import { describe, expect, it } from "bun:test"
import {
    acct,
    oneTransfer,
    PROVEN_BATCHES,
    selfTransfer,
    allAccounts,
    mixedTransfers,
    transfer,
    zeroAmountWithFee,
} from "./__fixtures__/batches"
import { buildSettlementCircuitInput } from "./circuitInput"
import {
    AMOUNT_LIMIT,
    SETTLEMENT_ACCOUNTS,
    SETTLEMENT_PUBLIC_SIGNALS,
    SETTLEMENT_TRANSFERS,
    SettlementEncodingError,
    settlementPublicHash,
    settlementPublicSignals,
} from "./encoding"
import { DEFER_REASON, planSettlement } from "./planner"
import type { SettlementPlan } from "./types"

const A = acct(0x11)
const B = acct(0x22)
const C = acct(0x33)

const deltas = (plan: SettlementPlan) => Object.fromEntries(plan.changes.map(c => [c.account, c.delta]))

describe("planSettlement", () => {
    it("debits amount + fee from the sender and credits the amount", () => {
        const plan = planSettlement([transfer(A, B, 100n, 3n, 1n)], new Map([[A, 1_000n]]), new Map())
        expect(plan.deferred).toEqual([])
        expect(plan.changes).toEqual([
            { account: A, delta: -103n },
            { account: B, delta: 100n },
        ])
        expect(plan.balancesBefore).toEqual(new Map([[A, 1_000n], [B, 0n]]))
    })

    it("names every touched account, sorted, with the balance before for each", () => {
        const { transfers, balances, nonces } = mixedTransfers()
        const plan = planSettlement(transfers, balances, nonces)
        expect(plan.transfers.length).toBe(SETTLEMENT_TRANSFERS)
        const accounts = plan.changes.map(c => c.account)
        expect(accounts).toEqual([...new Set(transfers.flatMap(t => [t.from, t.to]))].sort())
        expect([...plan.balancesBefore.keys()]).toEqual(accounts)
        for (const a of accounts) expect(plan.balancesBefore.get(a)).toBe(balances.get(a) ?? 0n)
    })

    it("keeps sum(delta) = -sum(fee)", () => {
        for (const make of PROVEN_BATCHES) {
            const { transfers, balances, nonces } = make()
            const plan = planSettlement(transfers, balances, nonces)
            const fees = plan.transfers.reduce((s, t) => s + t.fee, 0n)
            expect(plan.changes.reduce((s, c) => s + c.delta, 0n)).toBe(-fees)
        }
    })

    it("plans every shared batch in full", () => {
        for (const make of PROVEN_BATCHES) {
            const { transfers, balances, nonces, name } = make()
            const plan = planSettlement(transfers, balances, nonces)
            expect({ name, deferred: plan.deferred.map(d => d.reason) }).toEqual({ name, deferred: [] })
        }
    })

    it("is deterministic", () => {
        const { transfers, balances, nonces } = mixedTransfers()
        expect(planSettlement(transfers, balances, nonces)).toEqual(planSettlement(transfers, balances, nonces))
    })

    it("lets a receiver spend what it received earlier in the batch, not before", () => {
        const first = transfer(B, C, 50n, 1n, 1n)
        const credit = transfer(A, B, 100n, 1n, 1n)
        const plan = planSettlement([first, credit], new Map([[A, 1_000n]]), new Map())
        expect(plan.transfers).toEqual([credit])
        expect(plan.deferred).toEqual([{ transfer: first, reason: DEFER_REASON.overdraft }])

        const inOrder = planSettlement([credit, first], new Map([[A, 1_000n]]), new Map())
        expect(inOrder.transfers).toEqual([credit, first])
        expect(deltas(inOrder)).toEqual({ [A]: -101n, [B]: 49n, [C]: 50n })
    })

    it("defers an overdraft and judges later transfers as if it were absent", () => {
        const big = transfer(A, B, 1_000n, 1n, 1n)
        const fits = transfer(A, C, 999n, 1n, 1n)
        const plan = planSettlement([big, fits], new Map([[A, 1_000n]]), new Map())
        expect(plan.deferred).toEqual([{ transfer: big, reason: DEFER_REASON.overdraft }])
        expect(plan.transfers).toEqual([fits])
        // B was only touched by the deferred transfer.
        expect(plan.changes.map(c => c.account)).toEqual([A, C])
        expect(deltas(plan)).toEqual({ [A]: -1_000n, [C]: 999n })
    })

    it("counts the fee in the overdraft check", () => {
        const t = transfer(A, B, 1_000n, 1n, 1n)
        expect(planSettlement([t], new Map([[A, 1_000n]]), new Map()).deferred[0].reason).toBe(DEFER_REASON.overdraft)
        expect(planSettlement([t], new Map([[A, 1_001n]]), new Map()).deferred).toEqual([])
    })

    it("debits a self-transfer before crediting it", () => {
        const { transfers, balances, nonces } = selfTransfer()
        const plan = planSettlement(transfers, balances, nonces)
        expect(plan.transfers.length).toBe(1)
        expect(plan.changes).toEqual([{ account: transfers[0].from, delta: -10n }])
        // One short of amount + fee: the credit back does not help.
        const short = planSettlement(transfers, new Map([[transfers[0].from, 509n]]), nonces)
        expect(short.deferred[0].reason).toBe(DEFER_REASON.overdraft)
    })

    it("keeps a zero amount, charging its fee and naming the receiver with delta 0", () => {
        const { transfers, balances, nonces } = zeroAmountWithFee()
        const plan = planSettlement(transfers, balances, nonces)
        expect(plan.changes).toEqual([
            { account: transfers[0].from, delta: -10n },
            { account: transfers[0].to, delta: 0n },
        ])
    })

    it("takes nonces consecutively from the account nonce + 1", () => {
        const n6 = transfer(A, B, 1n, 1n, 6n)
        const n7 = transfer(A, B, 1n, 1n, 7n)
        const n9 = transfer(A, B, 1n, 1n, 9n)
        const n8 = transfer(A, B, 1n, 1n, 8n)
        const plan = planSettlement([n6, n7, n9, n8], new Map([[A, 100n]]), new Map([[A, 5n]]))
        expect(plan.transfers).toEqual([n6, n7, n8])
        expect(plan.deferred).toEqual([{ transfer: n9, reason: DEFER_REASON.nonce }])
    })

    it("defers a reused or stale nonce", () => {
        const stale = transfer(A, B, 1n, 1n, 5n)
        const first = transfer(A, B, 1n, 1n, 6n)
        const replay = transfer(A, C, 1n, 1n, 6n)
        const plan = planSettlement([stale, first, replay], new Map([[A, 100n]]), new Map([[A, 5n]]))
        expect(plan.transfers).toEqual([first])
        expect(plan.deferred.map(d => d.reason)).toEqual([DEFER_REASON.nonce, DEFER_REASON.nonce])
    })

    it("does not spend a nonce on a deferred transfer", () => {
        const over = transfer(A, B, 1_000n, 1n, 1n)
        const next = transfer(A, B, 1n, 1n, 1n)
        const plan = planSettlement([over, next], new Map([[A, 10n]]), new Map())
        expect(plan.transfers).toEqual([next])
    })

    it("treats a missing account as nonce 0 and balance 0", () => {
        const plan = planSettlement([transfer(A, B, 0n, 0n, 1n)], new Map(), new Map())
        expect(plan.transfers.length).toBe(1)
        expect(planSettlement([transfer(A, B, 1n, 0n, 1n)], new Map(), new Map()).deferred[0].reason).toBe(
            DEFER_REASON.overdraft,
        )
    })

    it("defers the transfer after a full batch", () => {
        const N = SETTLEMENT_TRANSFERS
        const ts = Array.from({ length: N + 1 }, (_, i) => transfer(A, B, 1n, 1n, BigInt(i + 1)))
        const plan = planSettlement(ts, new Map([[A, 1_000n]]), new Map())
        expect(plan.transfers).toEqual(ts.slice(0, N))
        expect(plan.deferred).toEqual([{ transfer: ts[N], reason: DEFER_REASON.batchFull }])
    })

    it("fills every account slot; the transfer limit binds first (M = 2N)", () => {
        const { transfers, balances } = allAccounts()
        const extra = transfer(transfers[0].from, acct(0x03), 1n, 1n, 2n)
        const plan = planSettlement([...transfers, extra], balances, new Map())
        expect(plan.transfers).toEqual(transfers)
        expect(plan.changes.length).toBe(SETTLEMENT_ACCOUNTS)
        expect(plan.deferred).toEqual([{ transfer: extra, reason: DEFER_REASON.batchFull }])
    })

    it("defers a transfer whose commitment does not open", () => {
        const t = { ...transfer(A, B, 1n, 1n, 1n), amount: 2n }
        const plan = planSettlement([t], new Map([[A, 100n]]), new Map())
        expect(plan.deferred[0].reason).toBe(DEFER_REASON.commitmentMismatch)
    })

    it("defers malformed transfers", () => {
        const ok = transfer(A, B, 1n, 1n, 1n)
        const bad = [
            { ...ok, from: "0x" + "AB".repeat(32) },
            { ...ok, to: "0x1234" },
            { ...ok, amount: -1n },
            { ...ok, amount: AMOUNT_LIMIT },
            { ...ok, fee: AMOUNT_LIMIT },
            { ...ok, nonce: 1n << 64n },
            { ...ok, amount: 1 as unknown as bigint },
        ]
        for (const t of bad) {
            const plan = planSettlement([t], new Map([[A, 100n]]), new Map())
            expect(plan.deferred.map(d => d.reason)).toEqual([DEFER_REASON.invalidTransfer])
        }
    })

    it("defers a transfer that would take a balance to 2^128", () => {
        const top = AMOUNT_LIMIT - 1n
        const t = transfer(A, B, 1n, 0n, 1n)
        const plan = planSettlement([t], new Map([[A, 10n], [B, top]]), new Map())
        expect(plan.deferred[0].reason).toBe(DEFER_REASON.overflow)
        const before = planSettlement([t], new Map([[A, AMOUNT_LIMIT]]), new Map())
        expect(before.deferred[0].reason).toBe(DEFER_REASON.overflow)
    })

    it("returns an empty plan when nothing fits", () => {
        const plan = planSettlement([transfer(A, B, 5n, 1n, 1n)], new Map(), new Map())
        expect(plan.transfers).toEqual([])
        expect(plan.changes).toEqual([])
        expect(plan.balancesBefore.size).toBe(0)
    })
})

describe("buildSettlementCircuitInput", () => {
    it("produces the validators' public signals for every shared batch", () => {
        for (const make of PROVEN_BATCHES) {
            const { transfers, balances, nonces } = make()
            const plan = planSettlement(transfers, balances, nonces)
            const { input, publicSignals, publicHash } = buildSettlementCircuitInput(plan)
            expect(publicSignals.length).toBe(SETTLEMENT_PUBLIC_SIGNALS)
            expect(publicHash).toBe(settlementPublicHash(publicSignals))
            expect(input.publicHash).toBe(publicHash.toString())
            // The circuit reads the signer limbs from the sender's account slot.
            expect(input.signerHi).toBeUndefined()
            expect(input.signerLo).toBeUndefined()
            const expected = settlementPublicSignals(
                plan.transfers.map(t => ({ commitment: t.commitment, signer: t.from, nonce: t.nonce, fee: t.fee })),
                plan.changes.map(c => ({
                    account: c.account,
                    balanceBefore: plan.balancesBefore.get(c.account) as bigint,
                    delta: c.delta,
                })),
            )
            expect(publicSignals).toEqual(expected)
            for (const key of ["toHi", "toLo", "amount", "salt", "senderIndex", "receiverIndex"]) {
                expect((input[key] as string[]).length).toBe(SETTLEMENT_TRANSFERS)
            }
        }
    })

    it("points each transfer at its sender and receiver among the sorted accounts", () => {
        const { transfers, balances, nonces } = mixedTransfers()
        const plan = planSettlement(transfers, balances, nonces)
        const { input } = buildSettlementCircuitInput(plan)
        const accounts = plan.changes.map(c => c.account)
        plan.transfers.forEach((t, i) => {
            expect(accounts[Number((input.senderIndex as string[])[i])]).toBe(t.from)
            expect(accounts[Number((input.receiverIndex as string[])[i])]).toBe(t.to)
        })
    })

    const plan = () => {
        const { transfers, balances, nonces } = oneTransfer()
        return planSettlement(transfers, balances, nonces)
    }
    const refuses = (p: SettlementPlan, message: RegExp) => {
        expect(() => buildSettlementCircuitInput(p)).toThrow(SettlementEncodingError)
        expect(() => buildSettlementCircuitInput(p)).toThrow(message)
    }

    it("refuses an empty plan", () => refuses({ ...plan(), transfers: [] }, /0 transfers/))
    it("refuses unsorted changes", () => refuses({ ...plan(), changes: [...plan().changes].reverse() }, /sorted/))
    it("refuses a duplicate account", () => {
        const p = plan()
        refuses({ ...p, changes: [p.changes[0], p.changes[0], p.changes[1]] }, /sorted/)
    })
    it("refuses a missing balance", () => {
        const p = plan()
        p.balancesBefore.delete(p.changes[1].account)
        refuses(p, /no balance before/)
    })
    it("refuses a wrong delta", () => {
        const p = plan()
        refuses({ ...p, changes: [p.changes[0], { ...p.changes[1], delta: p.changes[1].delta + 1n }] }, /delta/)
    })
    it("refuses an account no transfer touches", () => {
        const p = plan()
        const extra = { account: acct(0xee), delta: 0n }
        p.balancesBefore.set(extra.account, 0n)
        refuses({ ...p, changes: [...p.changes, extra] }, /not touched/)
    })
    it("refuses a transfer touching an account outside the changes", () => {
        const p = plan()
        refuses({ ...p, changes: [p.changes[0]] }, /missing from the changes/)
    })
    it("refuses an overdraft", () => {
        const p = plan()
        p.balancesBefore.set(p.transfers[0].from, 0n)
        refuses(p, /overdraws/)
    })
    it("refuses a commitment that does not open", () => {
        const p = plan()
        refuses({ ...p, transfers: [{ ...p.transfers[0], salt: 2n }] }, /does not open/)
    })
})
