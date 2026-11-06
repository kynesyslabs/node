/**
 * The SDK gives a transaction of any type the universal gas and nonce edits,
 * so a type the node has no handler for (escrow, contracts, tokens, a made-up
 * name) used to pass every check and be applied as a fee and a nonce, with
 * its own effect silently dropped. The `txTypeAllowList` fork refuses every
 * type that is not implemented at pool admission and in the block pre-pass.
 *
 * The transactions come from the real SDK signer.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
const chain = {
    __esModule: true,
    default: {
        getLastBlockNumber: async () => tip,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}
mock.module("src/libs/blockchain/chain", () => chain)
mock.module("@/libs/blockchain/chain", () => chain)
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))

import { readFileSync } from "node:fs"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { verifyAdmissionEdits } from "@/libs/blockchain/validation/editBinding"
import { PEER, SENDER, demos, handMade, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"
import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

/** Types the SDK can build, or a client can name, that the node does not implement. */
const UNIMPLEMENTED: Array<[string, unknown]> = [
    ["escrow", { platform: "github", username: "someone", amount: "5", operation: "deposit" }],
    ["contractDeploy", { source: "contract C {}", constructorArgs: [] }],
    ["contractCall", { contractAddress: PEER, method: "get", args: [] }],
    ["tokenCreation", { name: "T", ticker: "T", decimals: 9, initialSupply: "1" }],
    ["tokenExecution", { tokenAddress: PEER, method: "transfer", args: [] }],
    ["ipfs", { operation: "IPFS_ADD", content: "aGk=" }],
    ["l2psInstantMessaging", { message: "m" }],
    ["NODE_ONLINE", { online: true }],
    ["madeUp", { anything: 1 }],
]

const unimplemented = async (type: string, data: unknown): Promise<Transaction> =>
    onTheWire(await handMade(type, data))
const pay = async (): Promise<Transaction> => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

/** Every safety fork a mainnet genesis switches on, and txTypeAllowList at `allowList`. */
function forks(allowList: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    const config = getSharedState.forkConfig as unknown as Record<string, { activationHeight: number | null }>
    config.osDenomination.activationHeight = 0
    config.nonceEnforcement.activationHeight = null
    config.gasFeeSeparation.activationHeight = null
    config.editBinding.activationHeight = 0
    config.nonceIntegrity.activationHeight = 0
    config.networkGovernance.activationHeight = 0
    config.txTypeAllowList = { activationHeight: allowList }
    getSharedState.lastBlockNumber = 100
    tip = 100
}

let saved: ForkConfigByName
beforeEach(() => {
    saved = getSharedState.forkConfig
})
afterEach(() => {
    getSharedState.forkConfig = saved
})

describe("txTypeAllowList fork config", () => {
    beforeEach(() => {
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    it("is dormant by default, so a node carrying the code applies history as before", () => {
        const defaults = DEFAULT_FORK_CONFIG as unknown as Record<string, { activationHeight: number | null }>
        expect(defaults.txTypeAllowList).toBeDefined()
        expect(defaults.txTypeAllowList.activationHeight).toBeNull()
        expect(isForkActive("txTypeAllowList" as never, 1_000_000)).toBe(false)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { txTypeAllowList: { activationHeight: 500 } } })
        expect(isForkActive("txTypeAllowList" as never, 499)).toBe(false)
        expect(isForkActive("txTypeAllowList" as never, 500)).toBe(true)
    })

    it("is switched on at block 0 by the mainnet template and the devnet", () => {
        const template = JSON.parse(readFileSync("docs/mainnet/genesis.template.json", "utf8"))
        expect(template.forks.txTypeAllowList).toEqual({ activationHeight: 0 })
        const devnet = JSON.parse(readFileSync("testing/devnet/genesis.devnet.json", "utf8"))
        expect(devnet.forks.txTypeAllowList).toEqual({ activationHeight: 0 })
    })
})

describe("pool admission", () => {
    it("refuses every type the node does not implement once active", async () => {
        forks(0)
        for (const [type, data] of UNIMPLEMENTED) {
            const verdict = await verifyAdmissionEdits(await unimplemented(type, data))
            expect(verdict.ok).toBe(false)
            expect(verdict.reason).toContain("not accepted")
        }
    })

    it("admits what the SDK builds for an implemented type", async () => {
        forks(0)
        expect(await verifyAdmissionEdits(await pay())).toEqual({ ok: true })
    })

    it("admits an unimplemented type while dormant, as before", async () => {
        forks(null)
        const [type, data] = UNIMPLEMENTED[0]
        expect(await verifyAdmissionEdits(await unimplemented(type, data))).toEqual({ ok: true })
    })
})

describe("block apply", () => {
    let caches: GCREntityCaches
    const original = {
        prepareEntities: HandleGCR.prepareEntities,
        saveGCREditChanges: HandleGCR.saveGCREditChanges,
        bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
    }
    const refuseUnboundEdits = (txs: Transaction[]): Promise<Set<string>> =>
        (HandleGCR as any).refuseUnboundEdits(txs, false, 101)

    beforeEach(() => {
        caches = {
            accounts: new Map([
                [SENDER, { pubkey: SENDER, balance: 1_000_000_000_000n, nonce: 7 } as any],
                [PEER, { pubkey: PEER, balance: 0n, nonce: 0 } as any],
            ]),
            storagePrograms: new Map(),
            tlsNotaries: new Map(),
            atomicWorks: new Map(),
            resourceSlots: new Map(),
        }
        ;(HandleGCR as any).prepareEntities = async () => caches
        ;(HandleGCR as any).saveGCREditChanges = async () => {}
        ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
    })
    afterEach(() => {
        Object.assign(HandleGCR, original)
    })

    it("applies an unimplemented type as a fee and a nonce while dormant, as before", async () => {
        forks(null)
        const [type, data] = UNIMPLEMENTED[0]
        const escrow = await unimplemented(type, data)

        const out = await HandleGCR.applyTransactions([escrow], false, { height: 101, timestampSec: 1 })

        expect(out.successfulTxs).toEqual([escrow.hash])
        expect(caches.accounts.get(SENDER).nonce).toBe(8)
    })

    it("once active, fails every unimplemented type in a block and applies none of its edits", async () => {
        forks(0)
        for (const [type, data] of UNIMPLEMENTED) {
            caches.accounts.get(SENDER).nonce = 7
            caches.accounts.get(SENDER).balance = 1_000_000_000_000n
            const tx = await unimplemented(type, data)

            const out = await HandleGCR.applyTransactions([tx], false, { height: 101, timestampSec: 1 })

            expect(out.failedTxs).toEqual([tx.hash])
            expect(out.successfulTxs).toEqual([])
            expect(caches.accounts.get(SENDER).nonce).toBe(7)
            expect(caches.accounts.get(SENDER).balance).toBe(1_000_000_000_000n)
        }
    })

    it("once active, still applies an implemented transaction next to a refused one", async () => {
        forks(0)
        const [type, data] = UNIMPLEMENTED[1]
        const bad = await unimplemented(type, data)
        const good = await pay()
        expect([...(await refuseUnboundEdits([bad, good]))]).toEqual([bad.hash])
    })

    it("judges the block from the tip, like the other apply gates", async () => {
        forks(101)
        const [type, data] = UNIMPLEMENTED[0]
        const escrow = await unimplemented(type, data)
        expect([...(await refuseUnboundEdits([escrow]))]).toEqual([])
        tip = 101
        expect([...(await refuseUnboundEdits([escrow]))]).toEqual([escrow.hash])
    })
})
