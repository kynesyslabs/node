/**
 * The signalling server stores each message as an `instantMessaging`
 * transaction signed by the node, with no edits: it pays no fee and spends no
 * nonce. Nothing tied that exemption to a node, so any key could sign such a
 * transaction and have it merged into a block and applied for free, as often
 * as it liked. Under `instantMessagingBinding` a message without edits is
 * merged and applied only when a validator staked at the tip signed it; a
 * message that carries the universal edits pays like any transaction.
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
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { verifyAdmissionEdits } from "@/libs/blockchain/validation/editBinding"
import { PEER, SENDER, handMade, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"
import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")
const { default: GCR } = await import("@/libs/blockchain/gcr/gcr")

let validators: string[] = []
let validatorReads: number[] = []
let validatorReadFails = false
const originalValidators = GCR.getGCRValidatorsAtBlockOrThrow
beforeEach(() => {
    validators = [PEER]
    validatorReads = []
    validatorReadFails = false
    ;(GCR as any).getGCRValidatorsAtBlockOrThrow = async (height: number) => {
        validatorReads.push(height)
        if (validatorReadFails) throw new Error("connection lost")
        return validators.map(address => ({ address, status: "2", valid_at: 0 }))
    }
})
afterEach(() => {
    ;(GCR as any).getGCRValidatorsAtBlockOrThrow = originalValidators
})

const DATA = { senderId: "a", targetId: "b", message: "m", timestamp: 1 }

/** A message signed by SENDER as the signalling server builds one: no edits. */
async function freeMessage(): Promise<Transaction> {
    const tx = onTheWire(await handMade("instantMessaging", DATA))
    tx.content.gcr_edits = []
    return tx
}

/** A message signed by SENDER with the gas and nonce edits the SDK gives every type. */
async function paidMessage(): Promise<Transaction> {
    return onTheWire(await handMade("instantMessaging", DATA))
}

/** Every safety fork a mainnet genesis switches on, and instantMessagingBinding at `binding`. */
function forks(binding: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    const config = getSharedState.forkConfig as unknown as Record<string, { activationHeight: number | null }>
    config.osDenomination.activationHeight = 0
    config.nonceEnforcement.activationHeight = null
    config.gasFeeSeparation.activationHeight = null
    config.editBinding.activationHeight = 0
    config.nonceIntegrity.activationHeight = 0
    config.networkGovernance.activationHeight = 0
    config.txTypeAllowList = { activationHeight: 0 }
    config.instantMessagingBinding = { activationHeight: binding }
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

describe("instantMessagingBinding fork config", () => {
    beforeEach(() => {
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    it("is dormant by default, so a node carrying the code applies history as before", () => {
        const defaults = DEFAULT_FORK_CONFIG as unknown as Record<string, { activationHeight: number | null }>
        expect(defaults.instantMessagingBinding).toBeDefined()
        expect(defaults.instantMessagingBinding.activationHeight).toBeNull()
        expect(isForkActive("instantMessagingBinding" as never, 1_000_000)).toBe(false)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { instantMessagingBinding: { activationHeight: 500 } } })
        expect(isForkActive("instantMessagingBinding" as never, 499)).toBe(false)
        expect(isForkActive("instantMessagingBinding" as never, 500)).toBe(true)
    })

    it("is switched on at block 0 by the mainnet template and the devnet", () => {
        const template = JSON.parse(readFileSync("docs/mainnet/genesis.template.json", "utf8"))
        expect(template.forks.instantMessagingBinding).toEqual({ activationHeight: 0 })
        const devnet = JSON.parse(readFileSync("testing/devnet/genesis.devnet.json", "utf8"))
        expect(devnet.forks.instantMessagingBinding).toEqual({ activationHeight: 0 })
    })
})

describe("consensus merge", () => {
    it("refuses a message without edits from a key that is not a staked validator", async () => {
        forks(0)
        const verdict = await verifyAdmissionEdits(await freeMessage())
        expect(verdict.ok).toBe(false)
        expect(verdict.reason).toContain("staked validator")
        expect(validatorReads).toEqual([100])
    })

    it("admits the same message signed by a validator staked at the tip", async () => {
        forks(0)
        validators = [PEER, SENDER]
        expect(await verifyAdmissionEdits(await freeMessage())).toEqual({ ok: true })
    })

    it("admits a message that pays its fee and nonce, from any key", async () => {
        forks(0)
        expect(await verifyAdmissionEdits(await paidMessage())).toEqual({ ok: true })
        expect(validatorReads).toEqual([])
    })

    it("admits a message without edits from any key while dormant, as before", async () => {
        forks(null)
        expect(await verifyAdmissionEdits(await freeMessage())).toEqual({ ok: true })
        expect(validatorReads).toEqual([])
    })

    it("refuses when the validator set cannot be read", async () => {
        forks(0)
        validators = [SENDER]
        validatorReadFails = true
        expect((await verifyAdmissionEdits(await freeMessage())).ok).toBe(false)
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
    const BALANCE = 1_000_000_000_000n

    beforeEach(() => {
        caches = {
            accounts: new Map([
                [SENDER, { pubkey: SENDER, balance: BALANCE, nonce: 7 } as any],
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

    it("applies a message without edits from any key for free while dormant, as before", async () => {
        forks(null)
        const messages = [await freeMessage(), await freeMessage()]
        const out = await HandleGCR.applyTransactions(messages, false, { height: 101, timestampSec: 1 })

        expect(out.successfulTxs).toEqual(messages.map(m => m.hash))
        expect(caches.accounts.get(SENDER).nonce).toBe(7)
        expect(caches.accounts.get(SENDER).balance).toBe(BALANCE)
    })

    it("once active, fails a message without edits from a key that is not a staked validator", async () => {
        forks(0)
        const message = await freeMessage()
        const out = await HandleGCR.applyTransactions([message], false, { height: 101, timestampSec: 1 })

        expect(out.failedTxs).toEqual([message.hash])
        expect(out.successfulTxs).toEqual([])
    })

    it("once active, applies a validator's message, reading the set once per block", async () => {
        forks(0)
        validators = [SENDER]
        const messages = [await freeMessage(), await freeMessage()]
        const out = await HandleGCR.applyTransactions(messages, false, { height: 101, timestampSec: 1 })

        expect(out.successfulTxs).toEqual(messages.map(m => m.hash))
        expect(validatorReads).toEqual([100])
    })

    it("once active, applies a paid message from any key, charging its fee and nonce", async () => {
        forks(0)
        const message = await paidMessage()
        const out = await HandleGCR.applyTransactions([message], false, { height: 101, timestampSec: 1 })

        expect(out.successfulTxs).toEqual([message.hash])
        expect(caches.accounts.get(SENDER).nonce).toBe(8)
        expect(caches.accounts.get(SENDER).balance < BALANCE).toBe(true)
    })

    it("judges the block from the tip, like the other apply gates", async () => {
        forks(101)
        const message = await freeMessage()
        expect([...(await refuseUnboundEdits([message]))]).toEqual([])
        tip = 101
        expect([...(await refuseUnboundEdits([message]))]).toEqual([message.hash])
    })

    it("does not apply the block when the validator set cannot be read", async () => {
        forks(0)
        validatorReadFails = true
        await expect(refuseUnboundEdits([await freeMessage()])).rejects.toThrow("State read failed")
    })
})
