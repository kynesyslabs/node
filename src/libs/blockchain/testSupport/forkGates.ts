import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"
import { PEER, SENDER } from "@/libs/blockchain/validation/editBinding.fixtures"
import { mockLogger } from "./mockMempoolDeps"

/**
 * Shared set-up for the tests of a consensus fork that gates pool admission
 * and block apply. The transactions come from the real SDK signer; the
 * chain, the logger, the validator set and the storage of block apply are
 * replaced.
 */

type ForkHeights = Record<string, { activationHeight: number | null }>

/** The tip the mocked chain reports; a test moves it to cross a fork height. */
export const chainTip = { height: 100 }

/** Replaces the chain and silences the logger. Call before loading handleGCR. */
export function mockChainAndLogger(): void {
    const chain = {
        __esModule: true,
        default: {
            getLastBlockNumber: async () => chainTip.height,
            getExistingTransactionHashes: async () => new Set<string>(),
        },
    }
    mock.module("src/libs/blockchain/chain", () => chain)
    mock.module("@/libs/blockchain/chain", () => chain)
    mockLogger("src/utilities/logger")
}

/**
 * The safety forks a mainnet genesis switches on at block 0, then `heights`
 * (fork name to activation height), with the tip at 100.
 */
export function mainnetForks(heights: Record<string, number | null>): void {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    const config = getSharedState.forkConfig as unknown as ForkHeights
    for (const name of ["osDenomination", "editBinding", "nonceIntegrity", "networkGovernance"]) {
        config[name].activationHeight = 0
    }
    config.nonceEnforcement.activationHeight = null
    config.gasFeeSeparation.activationHeight = null
    for (const [name, height] of Object.entries(heights)) {
        config[name] = { activationHeight: height }
    }
    getSharedState.lastBlockNumber = 100
    chainTip.height = 100
}

/** Puts back, after each test, the fork config the test replaced. */
export function restoreForkConfigAfterEach(): void {
    let saved: ForkConfigByName
    beforeEach(() => {
        saved = getSharedState.forkConfig
    })
    afterEach(() => {
        getSharedState.forkConfig = saved
    })
}

/** The activation tests every consensus fork passes. */
export function describeForkConfig(fork: string): void {
    describe(`${fork} fork config`, () => {
        beforeEach(() => {
            getSharedState.forkConfig = cloneDefaultForkConfig()
        })

        it("is dormant by default, so a node carrying the code applies history as before", () => {
            const defaults = DEFAULT_FORK_CONFIG as unknown as ForkHeights
            expect(defaults[fork]).toBeDefined()
            expect(defaults[fork].activationHeight).toBeNull()
            expect(isForkActive(fork as never, 1_000_000)).toBe(false)
        })

        it("activates only from a pinned height", () => {
            loadForkConfigFromGenesis({ forks: { [fork]: { activationHeight: 500 } } })
            expect(isForkActive(fork as never, 499)).toBe(false)
            expect(isForkActive(fork as never, 500)).toBe(true)
        })

        it("is switched on at block 0 by the mainnet template and the devnet", () => {
            for (const path of ["docs/mainnet/genesis.template.json", "testing/devnet/genesis.devnet.json"]) {
                const genesis = JSON.parse(readFileSync(path, "utf8"))
                expect(genesis.forks[fork]).toEqual({ activationHeight: 0 })
            }
        })
    })
}

/**
 * Replaces `GCR.getGCRValidatorsAtBlockOrThrow` for each test. `keys` are the
 * validators staked at any height (PEER by default), `reads` the heights
 * read, and `fails` makes the read throw.
 */
export function stubValidatorSet(gcr: object): { keys: string[]; reads: number[]; fails: boolean } {
    const set = { keys: [] as string[], reads: [] as number[], fails: false }
    const target = gcr as { getGCRValidatorsAtBlockOrThrow: (height: number) => Promise<unknown> }
    const original = target.getGCRValidatorsAtBlockOrThrow
    beforeEach(() => {
        set.keys = [PEER]
        set.reads = []
        set.fails = false
        target.getGCRValidatorsAtBlockOrThrow = async (height: number) => {
            set.reads.push(height)
            if (set.fails) throw new Error("connection lost")
            return set.keys.map(address => ({ address, status: "2", valid_at: 0 }))
        }
    })
    afterEach(() => {
        target.getGCRValidatorsAtBlockOrThrow = original
    })
    return set
}

export const SENDER_BALANCE = 1_000_000_000_000n

interface BlockApply {
    /** The entity rows apply reads and edits; SENDER starts at nonce 7. */
    caches: GCREntityCaches
    /** Applies `txs` as block 101. */
    apply(txs: Transaction[]): Promise<{ successfulTxs: string[]; failedTxs: string[] }>
    /** The hashes the pre-pass of block 101 refuses. */
    refused(txs: Transaction[]): Promise<string[]>
}

/**
 * Keeps block apply off the database for each test of the enclosing
 * describe: entities come from `caches` and nothing is saved.
 */
export function stubBlockApply(handleGCR: object): BlockApply {
    const target = handleGCR as Record<string, any>
    const original = {
        prepareEntities: target.prepareEntities,
        saveGCREditChanges: target.saveGCREditChanges,
        bulkUpdateAssignedTxs: target.bulkUpdateAssignedTxs,
    }
    const block: BlockApply = {
        caches: undefined as unknown as GCREntityCaches,
        apply: txs => target.applyTransactions(txs, false, { height: 101, timestampSec: 1 }),
        refused: async txs => [...(await target.refuseUnboundEdits(txs, false, 101))],
    }
    beforeEach(() => {
        block.caches = {
            accounts: new Map([
                [SENDER, { pubkey: SENDER, balance: SENDER_BALANCE, nonce: 7 } as any],
                [PEER, { pubkey: PEER, balance: 0n, nonce: 0 } as any],
            ]),
            storagePrograms: new Map(),
            tlsNotaries: new Map(),
            atomicWorks: new Map(),
            resourceSlots: new Map(),
        }
        target.prepareEntities = async () => block.caches
        target.saveGCREditChanges = async () => {}
        target.bulkUpdateAssignedTxs = async () => {}
    })
    afterEach(() => {
        Object.assign(target, original)
    })
    return block
}

interface TxGate {
    /** The fork's name in the fork config. */
    fork: string
    /** What the refused transactions are, for the test names. */
    gated: string
    /** The reason every refusal carries. */
    refusal: string
    /** One transaction of each kind the fork refuses. */
    txs(): Promise<Transaction[]>
    /** A transaction the fork lets through. */
    other(): Promise<Transaction>
    handleGCR: object
}

/**
 * The intake and block apply tests every fork that refuses a set of
 * transaction types passes: refused at RPC intake, pool admission, the block
 * pre-pass and apply, judged from the tip, and refused before any edit when
 * applied on its own.
 */
export function describeTxGate(spec: TxGate): void {
    const { fork, gated, refusal } = spec
    const at = (height: number | null) => mainnetForks({ [fork]: height })
    const validation = () => import("@/libs/blockchain/validation/editBinding")

    describe(`${fork} intake`, () => {
        it(`pool admission refuses ${gated} while the fork is active`, async () => {
            at(0)
            const { verifyAdmissionEdits } = await validation()
            for (const tx of await spec.txs()) {
                expect(await verifyAdmissionEdits(tx)).toEqual({ ok: false, reason: refusal })
            }
        })

        it(`RPC submission refuses ${gated} too`, async () => {
            at(0)
            const { verifyRpcEdits } = await validation()
            for (const tx of await spec.txs()) {
                expect(await verifyRpcEdits(tx)).toEqual({ ok: false, reason: refusal })
            }
        })

        it("admits other transactions while the fork is active", async () => {
            at(0)
            const { verifyAdmissionEdits, verifyRpcEdits } = await validation()
            expect(await verifyAdmissionEdits(await spec.other())).toEqual({ ok: true })
            expect(await verifyRpcEdits(await spec.other())).toEqual({ ok: true })
        })

        it(`does not refuse ${gated} for ${fork} while the fork is dormant`, async () => {
            at(null)
            const { verifyRpcEdits } = await validation()
            for (const tx of await spec.txs()) {
                expect((await verifyRpcEdits(tx)).reason).not.toBe(refusal)
            }
        })
    })

    describe(`${fork} block apply`, () => {
        const block = stubBlockApply(spec.handleGCR)
        const gcr = spec.handleGCR as Record<string, any>
        const sender = () => block.caches.accounts.get(SENDER) as any

        it(`refuses ${gated} in the pre-pass, next to a transaction the block applies`, async () => {
            at(0)
            const txs = await spec.txs()
            expect(await block.refused([...txs, await spec.other()])).toEqual(txs.map(tx => tx.hash))
        })

        it("fails them with no balance, nonce or attestation change", async () => {
            at(0)
            const txs = await spec.txs()
            const out = await block.apply(txs)
            expect(new Set(out.failedTxs)).toEqual(new Set(txs.map(tx => tx.hash)))
            expect(out.failedTxs).toHaveLength(txs.length)
            expect(out.successfulTxs).toEqual([])
            expect(sender().balance).toBe(SENDER_BALANCE)
            expect(sender().nonce).toBe(7)
            expect(block.caches.tlsNotaries.size).toBe(0)
        })

        it("judges the fork from the tip, like the other apply gates", async () => {
            at(101)
            const [tx] = await spec.txs()
            expect(await block.refused([tx])).toEqual([])
            chainTip.height = 101
            expect(await block.refused([tx])).toEqual([tx.hash])
        })

        it("refuses one applied on its own before any edit, and charges nothing", async () => {
            at(0)
            for (const tx of await spec.txs()) {
                for (const simulate of [true, false]) {
                    const out = await gcr.applyTransaction(block.caches, tx, false, simulate)
                    expect(out).toMatchObject({ success: false, message: refusal, appliedEditsCount: 0, unproven: true })
                }
            }
            expect(sender().balance).toBe(SENDER_BALANCE)
            expect(sender().nonce).toBe(7)
        })
    })
}
