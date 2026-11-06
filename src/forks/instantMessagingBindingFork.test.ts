/**
 * The signalling server stores each message as an `instantMessaging`
 * transaction signed by the node, with no edits: it pays no fee and spends no
 * nonce. Nothing tied that exemption to a node, so any key could sign such a
 * transaction and have it merged into a block and applied for free, as often
 * as it liked. Under `instantMessagingBinding` a message without edits is
 * merged and applied only when a validator staked at the tip signed it; a
 * message that carries the universal edits pays like any transaction.
 */

import { describe, expect, it } from "bun:test"

import {
    SENDER_BALANCE,
    chainTip,
    describeForkConfig,
    mainnetForks,
    mockChainAndLogger,
    restoreForkConfigAfterEach,
    stubBlockApply,
    stubValidatorSet,
} from "@/libs/blockchain/testSupport/forkGates"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { admissionReads, verifyAdmissionEdits } from "@/libs/blockchain/validation/editBinding"
import { PEER, SENDER, handMade, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"

mockChainAndLogger()

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")
const { default: GCR } = await import("@/libs/blockchain/gcr/gcr")

const validators = stubValidatorSet(GCR)
restoreForkConfigAfterEach()

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

/** The mainnet forks, and instantMessagingBinding at `binding`. */
const forks = (binding: number | null) =>
    mainnetForks({ txTypeAllowList: 0, instantMessagingBinding: binding })

describeForkConfig("instantMessagingBinding")

describe("consensus merge", () => {
    it("refuses a message without edits from a key that is not a staked validator", async () => {
        forks(0)
        const verdict = await verifyAdmissionEdits(await freeMessage())
        expect(verdict.ok).toBe(false)
        expect(verdict.reason).toContain("staked validator")
        expect(validators.reads).toEqual([100])
    })

    it("admits the same message signed by a validator staked at the tip", async () => {
        forks(0)
        validators.keys = [PEER, SENDER]
        expect(await verifyAdmissionEdits(await freeMessage())).toEqual({ ok: true })
    })

    it("admits a message that pays its fee and nonce, from any key", async () => {
        forks(0)
        expect(await verifyAdmissionEdits(await paidMessage())).toEqual({ ok: true })
        expect(validators.reads).toEqual([])
    })

    it("admits a message without edits from any key while dormant, as before", async () => {
        forks(null)
        expect(await verifyAdmissionEdits(await freeMessage())).toEqual({ ok: true })
        expect(validators.reads).toEqual([])
    })

    it("reads the tip and the validator set once for a whole merge", async () => {
        forks(0)
        validators.keys = [SENDER]
        const reads = admissionReads()
        for (let i = 0; i < 3; i++) {
            expect(await verifyAdmissionEdits(await freeMessage(), reads)).toEqual({ ok: true })
        }
        expect(validators.reads).toEqual([100])
    })

    it("refuses when the validator set cannot be read", async () => {
        forks(0)
        validators.keys = [SENDER]
        validators.fails = true
        expect((await verifyAdmissionEdits(await freeMessage())).ok).toBe(false)
    })
})

describe("block apply", () => {
    const block = stubBlockApply(HandleGCR)

    it("applies a message without edits from any key for free while dormant, as before", async () => {
        forks(null)
        const messages = [await freeMessage(), await freeMessage()]
        const out = await block.apply(messages)

        expect(out.successfulTxs).toEqual(messages.map(m => m.hash))
        expect(block.caches.accounts.get(SENDER).nonce).toBe(7)
        expect(block.caches.accounts.get(SENDER).balance).toBe(SENDER_BALANCE)
    })

    it("once active, fails a message without edits from a key that is not a staked validator", async () => {
        forks(0)
        const message = await freeMessage()
        const out = await block.apply([message])

        expect(out.failedTxs).toEqual([message.hash])
        expect(out.successfulTxs).toEqual([])
    })

    it("once active, applies a validator's message, reading the set once per block", async () => {
        forks(0)
        validators.keys = [SENDER]
        const messages = [await freeMessage(), await freeMessage()]
        const out = await block.apply(messages)

        expect(out.successfulTxs).toEqual(messages.map(m => m.hash))
        expect(validators.reads).toEqual([100])
    })

    it("once active, applies a paid message from any key, charging its fee and nonce", async () => {
        forks(0)
        const message = await paidMessage()
        const out = await block.apply([message])

        expect(out.successfulTxs).toEqual([message.hash])
        expect(block.caches.accounts.get(SENDER).nonce).toBe(8)
        expect(block.caches.accounts.get(SENDER).balance < SENDER_BALANCE).toBe(true)
    })

    it("judges the block from the tip, like the other apply gates", async () => {
        forks(101)
        const message = await freeMessage()
        expect(await block.refused([message])).toEqual([])
        chainTip.height = 101
        expect(await block.refused([message])).toEqual([message.hash])
    })

    it("does not apply the block when the validator set cannot be read", async () => {
        forks(0)
        validators.fails = true
        await expect(block.refused([await freeMessage()])).rejects.toThrow("State read failed")
    })
})
