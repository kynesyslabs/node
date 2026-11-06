/**
 * The SDK gives a transaction of any type the universal gas and nonce edits,
 * so a type the node has no handler for (escrow, contracts, tokens, a made-up
 * name) used to pass every check and be applied as a fee and a nonce, with
 * its own effect silently dropped. The `txTypeAllowList` fork refuses every
 * type that is not implemented at pool admission and in the block pre-pass.
 *
 * The transactions come from the real SDK signer.
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
} from "@/libs/blockchain/testSupport/forkGates"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { verifyAdmissionEdits } from "@/libs/blockchain/validation/editBinding"
import { PEER, SENDER, demos, handMade, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"

mockChainAndLogger()

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

restoreForkConfigAfterEach()

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

/** The mainnet forks, and txTypeAllowList at `allowList`. */
const forks = (allowList: number | null) => mainnetForks({ txTypeAllowList: allowList })

describeForkConfig("txTypeAllowList")

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
    const block = stubBlockApply(HandleGCR)

    it("applies an unimplemented type as a fee and a nonce while dormant, as before", async () => {
        forks(null)
        const [type, data] = UNIMPLEMENTED[0]
        const escrow = await unimplemented(type, data)

        const out = await block.apply([escrow])

        expect(out.successfulTxs).toEqual([escrow.hash])
        expect(block.caches.accounts.get(SENDER).nonce).toBe(8)
    })

    it("once active, fails every unimplemented type in a block and applies none of its edits", async () => {
        forks(0)
        const sender = block.caches.accounts.get(SENDER)
        for (const [type, data] of UNIMPLEMENTED) {
            sender.nonce = 7
            sender.balance = SENDER_BALANCE
            const tx = await unimplemented(type, data)

            const out = await block.apply([tx])

            expect(out.failedTxs).toEqual([tx.hash])
            expect(out.successfulTxs).toEqual([])
            expect(sender.nonce).toBe(7)
            expect(sender.balance).toBe(SENDER_BALANCE)
        }
    })

    it("once active, still applies an implemented transaction next to a refused one", async () => {
        forks(0)
        const [type, data] = UNIMPLEMENTED[1]
        const bad = await unimplemented(type, data)
        const good = await pay()
        expect(await block.refused([bad, good])).toEqual([bad.hash])
    })

    it("judges the block from the tip, like the other apply gates", async () => {
        forks(101)
        const [type, data] = UNIMPLEMENTED[0]
        const escrow = await unimplemented(type, data)
        expect(await block.refused([escrow])).toEqual([])
        chainTip.height = 101
        expect(await block.refused([escrow])).toEqual([escrow.hash])
    })
})
