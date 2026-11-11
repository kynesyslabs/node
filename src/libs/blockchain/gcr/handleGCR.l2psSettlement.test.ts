/**
 * L2PS settlement at block apply (docs/design/l2ps-zk-settlement.md,
 * "Interface v1 → Apply"). Every check fails the batch transaction (failed,
 * no edits), never the block. The verifier is replaced by one that accepts a
 * proof only for the public signals it was made for, as the circuit does, so
 * a batch planned on balances other than the working state fails.
 * Commitments and signatures come from encoding.ts and fixed-seed keys.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const logged: string[] = []
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => 100,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        warn: () => {},
        error: (m: unknown) => logged.push(String(m)),
        only: () => {},
        custom: () => {},
    },
}))

/** Proof id -> the public signals it was made for. */
const proofs = new Map<string, bigint[]>()
let verifierThrows = false
const verified: bigint[][] = []
mock.module("@/libs/l2ps/settlement/prover", () => ({
    proveSettlement: async () => {
        throw new Error("not used at apply")
    },
    verifySettlementProof: async (signals: bigint[], proof: { id?: string }) => {
        if (verifierThrows) throw new Error("verifier crashed")
        verified.push(signals)
        const bound = proofs.get(String(proof?.id))
        return !!bound && bound.length === signals.length && bound.every((s, i) => s === signals[i])
    },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { orderDeterministically } from "@/libs/consensus/v2/routines/deterministicOrder"
import { settlementPublicSignals } from "@/libs/l2ps/settlement/encoding"
import type { DecryptedTransfer, SettlementChange } from "@/libs/l2ps/settlement/types"
import { parseSettlement } from "@/libs/l2ps/settlement/validation"
import {
    batchTx,
    key,
    netChanges,
    recordOf,
    signedTransfer,
} from "@/libs/l2ps/settlement/__fixtures__/settlementKit"
import type { GCREntityCaches } from "./handleGCR"

const { default: HandleGCR, withSettlementEdits } = await import("./handleGCR")

const OS = 1_000_000_000n
const FEE = 3n * OS
const ALICE = key(1)
const BOB = key(2)
const CAROL = key(3)
const NODE = key(200)
const BURN = "0x" + "00".repeat(32)
const TREASURY = "0x" + "f7".repeat(32)

let caches: GCREntityCaches
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}
const saved = {
    forkConfig: getSharedState.forkConfig,
    PROD: getSharedState.PROD,
    chainId: getSharedState.chainId,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
    feeDistribution: (getSharedState as any).feeDistribution,
    lastBlockNumber: getSharedState.lastBlockNumber,
}

function freshCaches(): GCREntityCaches {
    const account = (pubkey: string, balance: bigint, nonce: number) =>
        [pubkey, { pubkey, balance, nonce } as any] as const
    return {
        accounts: new Map([
            account(ALICE.account, 100n * OS, 4),
            account(BOB.account, 10n * OS, 0),
            account(CAROL.account, 0n, 0),
            account(NODE.account, 0n, 0),
            account(BURN, 0n, 0),
            account(TREASURY, 0n, 0),
        ]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

function forks(settlement: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    for (const name of ["osDenomination", "gasFeeSeparation", "nonceEnforcement", "nonceIntegrity", "editBinding"]) {
        ;(getSharedState.forkConfig as any)[name].activationHeight = 0
    }
    getSharedState.forkConfig.l2psSettlement.activationHeight = settlement
    getSharedState.lastBlockNumber = 100
}

const balanceOf = (k: string) => (caches.accounts.get(k) as any).balance as bigint
const nonceOf = (k: string) => Number((caches.accounts.get(k) as any).nonce)
const snapshot = () =>
    [...caches.accounts].map(([k, v]) => [k, BigInt((v as any).balance), Number((v as any).nonce)])

let proofSeq = 0

/**
 * What the prover makes: a proof bound to the batch's commitments, nonces,
 * fees, changes and the balances it was planned on.
 */
function proven(
    transfers: DecryptedTransfer[],
    plannedOn: Map<string, bigint>,
    changes: SettlementChange[] = netChanges(transfers),
) {
    const record = recordOf(transfers, changes)
    const id = `p${++proofSeq}`
    proofs.set(
        id,
        settlementPublicSignals(
            transfers.map(t => ({ commitment: t.commitment, signer: t.from, nonce: t.nonce, fee: t.fee })),
            changes.map(c => ({ account: c.account, balanceBefore: plannedOn.get(c.account) ?? 0n, delta: c.delta })),
        ),
    )
    record.proof = { id }
    return record
}

const tipBalances = () => new Map([...caches.accounts].map(([k, v]) => [k, BigInt((v as any).balance)]))

let batchNonce = 1_800_000_000_000_000
const batch = (record: unknown, opts: Record<string, unknown> = {}) =>
    batchTx(record, { from: NODE.account, nonce: ++batchNonce, ...opts })

const pay = (from: typeof ALICE, to: string, amount: bigint, nonce: bigint, fee = FEE) =>
    signedTransfer({ from, to, amount, fee, nonce })

const apply = (txs: any[]) => HandleGCR.applyTransactions(orderDeterministically(txs), false)

beforeEach(() => {
    logged.length = 0
    verified.length = 0
    verifierThrows = false
    proofs.clear()
    caches = freshCaches()
    ;(HandleGCR as any).prepareEntities = async () => caches
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
    getSharedState.PROD = true
    getSharedState.chainId = 4242
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.additionalFee = 1
    ;(getSharedState as any).feeDistribution = {
        burnAddress: BURN,
        treasuryAddress: TREASURY,
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 50, treasuryPct: 50 },
        specialOps: { burnPct: 50, rpcPct: 25, treasuryPct: 25 },
    }
    forks(0)
})

afterEach(() => {
    Object.assign(HandleGCR, original)
    Object.assign(getSharedState, {
        forkConfig: saved.forkConfig,
        PROD: saved.PROD,
        chainId: saved.chainId,
        networkFee: saved.networkFee,
        rpcFee: saved.rpcFee,
        additionalFee: saved.additionalFee,
        lastBlockNumber: saved.lastBlockNumber,
    })
    ;(getSharedState as any).feeDistribution = saved.feeDistribution
})

describe("l2psBatch settlement under the fork", () => {
    it("applies the changes, spends each signer's nonces and credits the fees", async () => {
        const t1 = pay(ALICE, BOB.account, 5n * OS, 5n)
        const t2 = pay(ALICE, CAROL.account, 1n * OS, 6n)
        const t3 = pay(BOB, CAROL.account, 2n * OS, 1n)
        const tx = batch(proven([t1, t2, t3], tipBalances()))

        const out = await apply([tx])

        expect(out.successfulTxs).toEqual([tx.hash])
        expect(out.failedTxs).toEqual([])
        expect(balanceOf(ALICE.account)).toBe(100n * OS - 6n * OS - 2n * FEE)
        expect(balanceOf(BOB.account)).toBe(10n * OS + 5n * OS - 2n * OS - FEE)
        expect(balanceOf(CAROL.account)).toBe(3n * OS)
        expect(nonceOf(ALICE.account)).toBe(6)
        expect(nonceOf(BOB.account)).toBe(1)
        expect(balanceOf(BURN) + balanceOf(TREASURY)).toBe(3n * FEE)
        // Supply is conserved: what left the senders' fees went to burn and treasury.
        const total = [...caches.accounts.values()].reduce((s, a: any) => s + BigInt(a.balance), 0n)
        expect(total).toBe(110n * OS)
        // The batch's own submitter spends nothing.
        expect(nonceOf(NODE.account)).toBe(0)
        expect(balanceOf(NODE.account)).toBe(0n)
        // Public signals are rebuilt with the balances from the working state.
        expect(verified).toHaveLength(1)
    })

    it("lets two batches over the same account in one block see each other's effects", async () => {
        const first = [pay(ALICE, BOB.account, 5n * OS, 5n)]
        const firstRecord = proven(first, tipBalances())
        const afterFirst = tipBalances()
        afterFirst.set(ALICE.account, 100n * OS - 5n * OS - FEE)
        afterFirst.set(BOB.account, 15n * OS)
        const second = [pay(BOB, CAROL.account, 12n * OS, 1n), pay(ALICE, CAROL.account, 1n * OS, 6n)]
        const a = batch(firstRecord)
        const b = batch(proven(second, afterFirst))

        const out = await apply([b, a])

        expect(out.successfulTxs.sort()).toEqual([a.hash, b.hash].sort())
        // Bob could pay 12 only with the 5 from the first batch.
        expect(balanceOf(BOB.account)).toBe(15n * OS - 12n * OS - FEE)
        expect(balanceOf(CAROL.account)).toBe(13n * OS)
        expect(nonceOf(ALICE.account)).toBe(6)
    })

    it("fails a second batch whose proof bound the balances before the first", async () => {
        const tip = tipBalances()
        const a = batch(proven([pay(ALICE, BOB.account, 5n * OS, 5n)], tip))
        const b = batch(proven([pay(BOB, CAROL.account, 1n * OS, 1n)], tip))

        const out = await apply([a, b])

        expect(out.successfulTxs).toEqual([a.hash])
        expect(out.failedTxs).toEqual([b.hash])
        expect(balanceOf(CAROL.account)).toBe(0n)
        expect(nonceOf(BOB.account)).toBe(0)
    })

    it("reaches the same state whatever order the forging or syncing path passes", async () => {
        const first = [pay(ALICE, BOB.account, 5n * OS, 5n)]
        const afterFirst = tipBalances()
        afterFirst.set(ALICE.account, 95n * OS - FEE)
        afterFirst.set(BOB.account, 15n * OS)
        const txs = [
            batch(proven(first, tipBalances())),
            batch(proven([pay(BOB, CAROL.account, 12n * OS, 1n)], afterFirst)),
            batch(proven([pay(ALICE, CAROL.account, 1n * OS, 9n)], tipBalances())),
        ]

        const forged = await apply(txs)
        const forgedState = snapshot()
        caches = freshCaches()
        const synced = await apply([...txs].reverse())

        expect(synced).toEqual(forged)
        expect(snapshot()).toEqual(forgedState)
        expect(forged.failedTxs).toEqual([txs[2].hash])
    })

    it("applies a batch with zero fee credits nothing to burn or treasury when the floor is zero", async () => {
        getSharedState.networkFee = 0
        getSharedState.rpcFee = 0
        getSharedState.additionalFee = 0
        const tx = batch(proven([pay(ALICE, BOB.account, 1n, 5n, 0n)], tipBalances()))

        const out = await apply([tx])

        expect(out.successfulTxs).toEqual([tx.hash])
        expect(balanceOf(BURN) + balanceOf(TREASURY)).toBe(0n)
        expect(balanceOf(BOB.account)).toBe(10n * OS + 1n)
    })
})

describe("a failing settlement is included as failed with no edits", () => {
    async function expectFailed(tx: any, reason: string) {
        const before = snapshot()
        const out = await apply([tx])
        expect(out.failedTxs).toEqual([tx.hash])
        expect(out.successfulTxs).toEqual([])
        expect(snapshot()).toEqual(before)
        expect(logged.some(m => m.includes(reason))).toBe(true)
    }

    it("a native transfer fee that is not an amount, without failing the block", async () => {
        const tx = batch(proven([pay(ALICE, BOB.account, OS, 5n)], tipBalances()))
        getSharedState.networkFee = 0.5
        await expectFailed(tx, "native transfer fee is not an amount")
    })

    it("fee credits that would burn part of the fees: no distribution loaded", async () => {
        ;(getSharedState as any).feeDistribution = null
        await expectFailed(batch(proven([pay(ALICE, BOB.account, OS, 5n)], tipBalances())), "fee credits 0 do not add up")
    })

    it("fee credits that would burn part of the fees: every share zero", async () => {
        const zero = { burnPct: 0, treasuryPct: 0 }
        ;(getSharedState as any).feeDistribution = {
            burnAddress: BURN,
            treasuryAddress: TREASURY,
            networkFee: zero,
            additionalFee: zero,
            specialOps: { burnPct: 0, rpcPct: 0, treasuryPct: 0 },
        }
        await expectFailed(batch(proven([pay(ALICE, BOB.account, OS, 5n)], tipBalances())), "do not add up to the fees")
    })

    it("bad signature", async () => {
        const t = pay(ALICE, BOB.account, 1n * OS, 5n)
        t.signature = pay(BOB, BOB.account, 1n * OS, 5n).signature
        await expectFailed(batch(proven([t], tipBalances())), "signature does not verify")
    })

    it("signature for another chain", async () => {
        const t = signedTransfer({ from: ALICE, to: BOB.account, amount: OS, fee: FEE, nonce: 5n, chainId: 1 })
        await expectFailed(batch(proven([t], tipBalances())), "signature does not verify")
    })

    it("replayed nonce", async () => {
        await expectFailed(batch(proven([pay(ALICE, BOB.account, OS, 4n)], tipBalances())), "next nonce 5")
    })

    it("nonce gap", async () => {
        await expectFailed(batch(proven([pay(ALICE, BOB.account, OS, 6n)], tipBalances())), "next nonce 5")
    })

    it("nonces of one signer out of order inside the batch", async () => {
        const ts = [pay(ALICE, BOB.account, OS, 6n), pay(ALICE, BOB.account, OS, 5n)]
        await expectFailed(batch(proven(ts, tipBalances())), "next nonce 5")
    })

    it("fee below the native transfer fee", async () => {
        await expectFailed(batch(proven([pay(ALICE, BOB.account, OS, 5n, FEE - 1n)], tipBalances())), "below the native transfer fee")
    })

    it("unsorted changes", async () => {
        const t = [pay(ALICE, BOB.account, OS, 5n)]
        const record = proven(t, tipBalances())
        record.changes.reverse()
        await expectFailed(batch(record), "not sorted")
    })

    it("duplicate changes", async () => {
        const t = [pay(ALICE, BOB.account, OS, 5n)]
        const [c0, c1] = netChanges(t)
        const record = proven(t, tipBalances())
        record.changes = [
            { account: c0.account, delta: (c0.delta - 1n).toString() },
            { account: c0.account, delta: "1" },
            { account: c1.account, delta: c1.delta.toString() },
        ]
        await expectFailed(batch(record), "not sorted")
    })

    it("delta out of range", async () => {
        const record = proven([pay(ALICE, BOB.account, OS, 5n)], tipBalances())
        record.changes[0].delta = (1n << 128n).toString()
        await expectFailed(batch(record), "delta")
    })

    it('delta "-0"', async () => {
        const record = proven([pay(ALICE, BOB.account, OS, 5n)], tipBalances())
        record.changes.push({ account: "0x" + "ff".repeat(32), delta: "-0" })
        await expectFailed(batch(record), "delta")
    })

    it("changes that do not name a signer", async () => {
        const t = pay(ALICE, BOB.account, 0n, 5n, 0n)
        getSharedState.networkFee = 0
        getSharedState.rpcFee = 0
        getSharedState.additionalFee = 0
        const record = proven([t], tipBalances(), [{ account: BOB.account, delta: 0n }])
        await expectFailed(batch(record), "not named in changes")
    })

    it("changes that do not sum to minus the fees", async () => {
        const t = [pay(ALICE, BOB.account, OS, 5n)]
        const changes = netChanges(t).map(c => ({ ...c, delta: c.account === BOB.account ? c.delta + 1n : c.delta }))
        await expectFailed(batch(proven(t, tipBalances(), changes)), "sum to minus the fees")
    })

    it("proof that does not verify", async () => {
        const plannedOn = tipBalances()
        plannedOn.set(ALICE.account, 1_000n * OS)
        await expectFailed(batch(proven([pay(ALICE, BOB.account, OS, 5n)], plannedOn)), "proof does not verify")
    })

    it("no settlement record (the format before the fork)", async () => {
        const tx = batch(undefined)
        delete tx.content.data[1].settlement
        await expectFailed(tx, "old format")
    })

    it("more than 10 transfers", async () => {
        const ts = Array.from({ length: 11 }, (_, i) => pay(ALICE, BOB.account, 1n, 5n + BigInt(i)))
        const record = recordOf(ts)
        await expectFailed(batch(record), "1..10 transfers")
    })

    it("more than 20 changes", async () => {
        const ts = [pay(ALICE, BOB.account, OS, 5n)]
        const record = recordOf(ts)
        for (let i = 0; i < 20; i++) {
            record.changes.push({ account: "0x" + "ee".repeat(31) + i.toString(16).padStart(2, "0"), delta: "0" })
        }
        await expectFailed(batch(record), "1..20 changes")
    })
})

describe("a verifier that cannot judge a proof", () => {
    const clock = { height: 7, timestampSec: 1_700_000_000 }
    // Forge and a verified Sync block defer the write; the plain shape saves it.
    const shapes: [string, Record<string, unknown>][] = [
        ["forge and Sync (deferred write)", { defer: true }],
        ["direct apply (immediate write)", {}],
    ]

    for (const [name, options] of shapes) {
        it(`rejects the whole block apply with no edits: ${name}`, async () => {
            let saved = 0
            ;(HandleGCR as any).saveGCREditChanges = async () => {
                saved++
            }
            const tx = batch(proven([pay(ALICE, BOB.account, OS, 5n)], tipBalances()))
            const before = snapshot()
            verifierThrows = true

            await expect(
                HandleGCR.applyTransactions([tx as any], false, clock, options),
            ).rejects.toThrow("verifier crashed")

            expect(saved).toBe(0)
            expect(snapshot()).toEqual(before)
        })
    }

    it("is not the same as a proof that does not verify, which fails only its batch", async () => {
        const plannedOn = tipBalances()
        plannedOn.set(ALICE.account, 1_000n * OS)
        const bad = batch(proven([pay(ALICE, BOB.account, OS, 5n)], plannedOn))
        const good = batch(proven([pay(BOB, CAROL.account, 2n * OS, 1n)], tipBalances()))

        const out = await HandleGCR.applyTransactions(orderDeterministically([bad, good]) as any, false, clock, {
            defer: true,
        })

        expect(out.failedTxs).toEqual([bad.hash])
        expect(out.successfulTxs).toEqual([good.hash])
        expect(out.pending).toBeDefined()
        expect(balanceOf(CAROL.account)).toBe(2n * OS)
        expect(balanceOf(ALICE.account)).toBe(100n * OS)
    })
})

describe("the per-block cap of 20 settlement batches", () => {
    it("fails every batch past the 20th in canonical order and applies the rest", async () => {
        getSharedState.networkFee = 0
        getSharedState.rpcFee = 0
        getSharedState.additionalFee = 0
        // Disjoint accounts, so every batch is valid on its own.
        const keys = Array.from({ length: 21 }, (_, i) => key(10 + i))
        const sink = (i: number) => "0x" + "dd".repeat(31) + i.toString(16).padStart(2, "0")
        keys.forEach((k, i) => {
            caches.accounts.set(k.account, { pubkey: k.account, balance: 10n, nonce: 0 } as any)
            caches.accounts.set(sink(i), { pubkey: sink(i), balance: 0n, nonce: 0 } as any)
        })
        const txs = keys.map((k, i) =>
            batch(proven([signedTransfer({ from: k, to: sink(i), amount: 1n, fee: 0n, nonce: 1n })], tipBalances())),
        )

        const out = await apply(txs)

        const ordered = orderDeterministically(txs)
        expect(out.successfulTxs.sort()).toEqual(ordered.slice(0, 20).map(t => t.hash).sort())
        expect(out.failedTxs).toEqual([ordered[20].hash])
        const paid = keys.filter((_, i) => balanceOf(sink(i)) === 1n)
        expect(paid).toHaveLength(20)
        expect(logged.some(m => m.includes("per-block settlement batch cap"))).toBe(true)
    })
})

describe("before the fork", () => {
    it("moves no balance for an l2psBatch, whatever it carries", async () => {
        forks(null)
        const tx = batch(proven([pay(ALICE, BOB.account, 5n * OS, 5n)], tipBalances()))
        const before = snapshot()

        const out = await apply([tx])

        expect(out.failedTxs).toEqual([])
        expect(snapshot()).toEqual(before)
        expect(verified).toHaveLength(0)
    })

    it("stays dormant on tip H when it activates at H + 1", async () => {
        forks(101)
        const tx = batch(proven([pay(ALICE, BOB.account, 5n * OS, 5n)], tipBalances()))
        const before = snapshot()

        await apply([tx])

        expect(snapshot()).toEqual(before)
    })
})

describe("an account a settlement names with a zero delta", () => {
    // The rows the database holds; prepareEntities loads only the accounts
    // the block's transactions name, as it does on a node.
    let db: Map<string, { balance: bigint; nonce: number }>
    const originalLoad = (HandleGCR as any).loadGCRMainEntities
    const clock = { height: 101, timestampSec: 1_800_000_000 }

    beforeEach(() => {
        getSharedState.networkFee = 0
        getSharedState.rpcFee = 0
        getSharedState.additionalFee = 0
        db = new Map([
            [ALICE.account, { balance: 100n * OS, nonce: 4 }],
            [BOB.account, { balance: 10n * OS, nonce: 0 }],
            [CAROL.account, { balance: 10n * OS, nonce: 0 }],
        ])
        ;(HandleGCR as any).prepareEntities = original.prepareEntities
        ;(HandleGCR as any).loadGCRMainEntities = async (pubkeys: Set<string>) =>
            new Map(
                [...pubkeys].map(pubkey => {
                    const row = db.get(pubkey) ?? { balance: 0n, nonce: 0 }
                    return [pubkey, { pubkey, balance: row.balance, nonce: row.nonce } as any]
                }),
            )
    })

    afterEach(() => {
        ;(HandleGCR as any).loadGCRMainEntities = originalLoad
    })

    /** The public signals the circuit binds for `transfers` planned on `balances`. */
    const signalsOf = (transfers: DecryptedTransfer[], balances: Map<string, bigint>) =>
        settlementPublicSignals(
            transfers.map(t => ({ commitment: t.commitment, signer: t.from, nonce: t.nonce, fee: t.fee })),
            netChanges(transfers).map(c => ({ account: c.account, balanceBefore: balances.get(c.account) ?? 0n, delta: c.delta })),
        )
    const dbBalances = () => new Map([...db].map(([k, v]) => [k, v.balance]))

    it("is read at its real balance when nothing else in the block names it", async () => {
        const zero = [pay(ALICE, BOB.account, 0n, 5n, 0n)]
        const tx = batch(proven(zero, dbBalances()))

        const out = await HandleGCR.applyTransactions([tx as any], false, clock, { defer: true })

        expect(out.failedTxs).toEqual([])
        expect(out.successfulTxs).toEqual([tx.hash])
        expect(verified).toEqual([signalsOf(zero, dbBalances())])
    })

    it("gives the forging and the syncing path the same verdict and the balance the block's earlier transaction left", async () => {
        // Another member node submits the second batch; its key sorts first,
        // so its credit to Bob comes before the zero-amount transfer.
        const other = Array.from({ length: 20 }, (_, i) => key(201 + i)).find(k => k.account < NODE.account)!
        const credit = [pay(CAROL, BOB.account, 1n * OS, 1n, 0n)]
        const zero = [pay(ALICE, BOB.account, 0n, 5n, 0n)]
        const afterCredit = dbBalances()
        afterCredit.set(CAROL.account, 9n * OS)
        afterCredit.set(BOB.account, 11n * OS)
        const y = batchTx(proven(credit, dbBalances()), { from: other.account, nonce: 1 })
        const x = batch(proven(zero, afterCredit))
        const block = orderDeterministically([x, y] as any[])
        expect(block.map(t => t.hash)).toEqual([y.hash, x.hash])

        // The batch reads Bob, so it is ordered with every transaction that writes him.
        const derived = block.map(t => withSettlementEdits(t, parseSettlement(t).ok ? (parseSettlement(t) as any).value : undefined))
        const groups = HandleGCR.partitionIndependentTxs(derived)
        expect(groups).toHaveLength(1)

        const forged = await HandleGCR.applyTransactions(block, false, clock, { defer: true })
        const forgedSignals = [...verified]
        verified.length = 0
        const synced = await HandleGCR.applyTransactions(orderDeterministically([y, x] as any[]), false, clock)

        expect(forged.failedTxs).toEqual([])
        expect(forged.successfulTxs.sort()).toEqual([x.hash, y.hash].sort())
        expect([...synced.successfulTxs].sort()).toEqual(forged.successfulTxs)
        expect(synced.failedTxs).toEqual(forged.failedTxs)
        expect(verified).toEqual(forgedSignals)
        expect(forgedSignals).toContainEqual(signalsOf(zero, afterCredit))
    })
})
