/**
 * A peer that signs its own transactions can ship any edits with them. Both
 * doors into the pool, gossip ingest and the consensus mempool merge, must
 * refuse the edit kinds that used to slip through for non-native types, and
 * must still admit what the SDK builds.
 *
 * The edit binding, the SDK and its serialiser are the real ones; only the
 * pool's storage and the chain are replaced.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"
import { getSharedState } from "@/utilities/sharedState"

import { installPoolStorageMocks, installPoolValidationMocks } from "./mempool.fixtures"

const inserted = installPoolStorageMocks()

const logged: string[] = []

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: (m: unknown) => logged.push(String(m)),
        only: () => {},
        custom: () => {},
    },
}))
// Identity proofs are checked by their own admission step; this file covers
// only the edit binding.
installPoolValidationMocks()

// The fee rule judges on the parameters the last read loaded; a failed read
// leaves them as they were.
let parametersReadable = true
let parameterRefreshes = 0
const realParameters = await import("src/libs/blockchain/routines/loadNetworkParameters")
mock.module("src/libs/blockchain/routines/loadNetworkParameters", () => ({
    ...realParameters,
    ensureNetworkParametersCurrent: async () => {
        parameterRefreshes++
        if (!parametersReadable) throw new Error("connection reset")
    },
}))

import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "./mempool"
import { verifyRpcEdits } from "./validation/editBinding"
import { OS, PEER, SENDER, VICTIM, chainIs, demos, onTheWire, viaConfirm } from "./validation/editBinding.fixtures"

const identities = new Identities()
const storageAddress = StorageProgram.createStorageProgram(SENDER, "probe", { a: 1 }, "json", undefined, { nonce: 1 }).storageAddress

const builders: Record<string, () => Promise<Transaction>> = {
    storageWrite: () => demos.storagePrograms.sign(StorageProgram.writeStorage(storageAddress, { a: 2 }, "json")),
    unstake: () => DemosTransactions.unstake(demos),
    vote: () => DemosTransactions.voteOnUpgrade("11111111-1111-4111-8111-111111111111", true, demos),
    identity: () =>
        viaConfirm(() =>
            identities.inferXmIdentity(
                demos,
                {
                    target_identity: {
                        chain: "evm",
                        subchain: "mainnet",
                        isEVM: true,
                        chainId: 1,
                        targetAddress: "0x" + "ee".repeat(20),
                        signature: "0x12",
                        publicKey: "0x34",
                    },
                } as never,
                "ref1",
            ),
        ),
}

type Forgery = [name: string, base: keyof typeof builders, tamper: (edits: Array<Record<string, any>>) => void]

const forgeries: Forgery[] = [
    ["a nonce bump on another account", "unstake", e => e.push({ type: "nonce", operation: "add", account: VICTIM, amount: 1000, isRollback: false, txhash: "" })],
    ["a vote under another validator", "vote", e => (e.find(x => x.type === "networkUpgradeVote")!.account = VICTIM)],
    ["a storage write naming another sender", "storageWrite", e => (e.find(x => x.type === "storageProgram")!.context.sender = VICTIM)],
    ["an identity attached to another account", "identity", e => (e.find(x => x.type === "identity")!.account = VICTIM)],
    [
        "a points credit",
        "storageWrite",
        e => e.push({ type: "identity", context: "points", isRollback: false, operation: "add", account: SENDER, amount: 1_000_000, date: new Date().toISOString(), txhash: "" }),
    ],
    ["a balance credit", "unstake", e => e.push({ type: "balance", operation: "add", account: SENDER, amount: String(1_000_000n * OS), isRollback: false, txhash: "" })],
]

async function forged(base: keyof typeof builders, tamper: Forgery[2]): Promise<Transaction> {
    const tx = onTheWire(await builders[base]())
    tamper(tx.content.gcr_edits as unknown as Array<Record<string, any>>)
    return tx
}

const validity = (tx: Transaction): ValidityData =>
    ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData

beforeEach(() => {
    chainIs(true)
    inserted.length = 0
    logged.length = 0
    ;(Mempool as any).repo = { find: async () => [] }
    ;(Mempool as any).addTransactionWithLock = async () => ({ confirmationBlock: 101 })
})

describe("Mempool.ingestGossiped before the fork", () => {
    beforeEach(() => chainIs(true, null))

    it("admits what the old checks admitted, including edits only the new rule refuses", async () => {
        const tx = await forged("unstake", forgeries[0][2])
        expect(await Mempool.ingestGossiped(validity(tx))).toMatchObject({ accepted: true })
    })

    it("still refuses a balance credit on a non-native transaction", async () => {
        const tx = await forged("unstake", forgeries[5][2])
        const out = await Mempool.ingestGossiped(validity(tx))
        expect(out.accepted).toBe(false)
        expect(out.reason).toContain("value edits")
    })
})

describe("Mempool.receive before the fork", () => {
    beforeEach(() => chainIs(true, null))
    const row = (tx: Transaction) => ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

    it("admits what the old checks admitted and refuses a balance credit", async () => {
        const nonceBump = await forged("unstake", forgeries[0][2])
        const mint = await forged("storageWrite", forgeries[5][2])
        await Mempool.receive([row(nonceBump), row(mint)], false)
        expect(inserted.map(r => r.hash)).toEqual([nonceBump.hash])
    })
})

describe("Mempool.ingestGossiped", () => {
    for (const name of Object.keys(builders)) {
        it(`admits an unmodified ${name} transaction`, async () => {
            const tx = onTheWire(await builders[name]())
            expect(await Mempool.ingestGossiped(validity(tx))).toMatchObject({ accepted: true })
        })
    }

    for (const [name, base, tamper] of forgeries) {
        it(`refuses ${name}`, async () => {
            const tx = await forged(base, tamper)
            const out = await Mempool.ingestGossiped(validity(tx))
            expect(out.accepted).toBe(false)
            // A governance edit is refused by the networkGovernance rule first.
            expect(out.reason).toMatch(/gcr_edits|another account than the signer/)
        })
    }
})

describe("Mempool.receive", () => {
    const row = (tx: Transaction) => ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

    for (const name of Object.keys(builders)) {
        it(`admits an unmodified ${name} transaction`, async () => {
            const tx = onTheWire(await builders[name]())
            await Mempool.receive([row(tx)], false)
            expect(inserted.map(r => r.hash)).toEqual([tx.hash])
        })
    }

    for (const [name, base, tamper] of forgeries) {
        it(`refuses ${name}`, async () => {
            const tx = await forged(base, tamper)
            await Mempool.receive([row(tx)], false)
            expect(inserted).toHaveLength(0)
            expect(logged.some(m => m.includes(`Rejecting tx ${tx.hash}`))).toBe(true)
        })
    }

    it("under feeBinding, aborts the merge rather than judge fees on parameters it could not refresh", async () => {
        getSharedState.forkConfig.feeBinding.activationHeight = 0
        parametersReadable = false
        parameterRefreshes = 0
        try {
            const honest = onTheWire(await builders.unstake())
            await expect(Mempool.receive([row(honest)], false)).rejects.toMatchObject({
                name: "StateReadError",
            })
            expect(parameterRefreshes).toBe(1)
            expect(inserted).toHaveLength(0)
            expect(logged.some(m => m.includes("Rejecting tx"))).toBe(false)
        } finally {
            parametersReadable = true
        }
    })

    it("does not refresh the parameters before feeBinding", async () => {
        parameterRefreshes = 0
        const honest = onTheWire(await builders.unstake())
        await Mempool.receive([row(honest)], false)
        expect(parameterRefreshes).toBe(0)
        expect(inserted.map(r => r.hash)).toEqual([honest.hash])
    })

    it("admits the honest transactions of a batch that also holds a forgery", async () => {
        const honest = onTheWire(await builders.unstake())
        const bad = await forged("vote", forgeries[1][2])
        await Mempool.receive([row(bad), row(honest)], false)
        expect(inserted.map(r => r.hash)).toEqual([honest.hash])
    })
})

describe("single intake under feeBinding", () => {
    // Gossip and RPC take one tx at a time; with no batch to fail, the tx is
    // refused instead of judged on fees a failed read may have left stale.
    for (const editBinding of [0, null] as const) {
        const label = editBinding === null ? " before editBinding" : ""
        it(`refuses a gossiped tx while the parameters cannot be refreshed${label}`, async () => {
            chainIs(true, editBinding)
            getSharedState.forkConfig.feeBinding.activationHeight = 0
            parametersReadable = false
            parameterRefreshes = 0
            try {
                const honest = onTheWire(await builders.unstake())
                const out = await Mempool.ingestGossiped(validity(honest))
                expect(out.accepted).toBe(false)
                expect(out.reason).toContain("network parameters")
                expect(parameterRefreshes).toBe(1)
            } finally {
                parametersReadable = true
            }
        })

        it(`refuses an RPC tx while the parameters cannot be refreshed${label}`, async () => {
            chainIs(true, editBinding)
            getSharedState.forkConfig.feeBinding.activationHeight = 0
            parametersReadable = false
            try {
                const honest = onTheWire(await builders.unstake())
                const verdict = await verifyRpcEdits(honest)
                expect(verdict.ok).toBe(false)
                expect((verdict as { reason: string }).reason).toContain("connection reset")
            } finally {
                parametersReadable = true
            }
        })
    }

    it("admits once the parameters are read again", async () => {
        getSharedState.forkConfig.feeBinding.activationHeight = 0
        parameterRefreshes = 0
        const honest = onTheWire(await builders.unstake())
        expect(await Mempool.ingestGossiped(validity(honest))).toMatchObject({ accepted: true })
        expect((await verifyRpcEdits(honest)).ok).toBe(true)
        expect(parameterRefreshes).toBe(2)
    })
})
