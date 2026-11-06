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
