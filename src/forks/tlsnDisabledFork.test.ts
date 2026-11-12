/**
 * Mainnet launches with TLSNotary off. Under `tlsnDisabled` a native
 * `tlsn_request` or `tlsn_store` is refused at RPC intake, pool admission and
 * apply before any of its edits run: it pays no fee, burns nothing and no
 * attestation token is issued.
 *
 * The transactions come from the real SDK builders (TLSNotaryService).
 */

import { describe, expect, it, mock } from "bun:test"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { TLSNotaryService } from "@kynesyslabs/demosdk/tlsnotary/service"
import type { Transaction } from "@kynesyslabs/demosdk/types"

const repoFor = (name: string) => ({
    target: { name },
    create: (row: unknown) => ({ ...(row as object) }),
    findOneBy: async () => null,
    findOne: async () => null,
    find: async () => [],
    save: async (row: unknown) => row,
})
const fakeDataSource = {
    getRepository: (entity: any) => repoFor(entity?.name ?? String(entity)),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

// Every token the simulation would issue for a tlsn_request.
const issuedTokens: unknown[] = []
mock.module("@/features/tlsnotary/tokenManager", () => ({
    createToken: (...args: unknown[]) => {
        issuedTokens.push(args)
        return { id: "token-1" }
    },
    extractDomain: (url: string) => new URL(url).hostname,
}))

const {
    SENDER_BALANCE,
    chainTip,
    describeForkConfig,
    mainnetForks,
    mockChainAndLogger,
    restoreForkConfigAfterEach,
    stubBlockApply,
} = await import("@/libs/blockchain/testSupport/forkGates")
mockChainAndLogger()

const handleGCR = (await import("@/libs/blockchain/gcr/handleGCR")).default
const { verifyAdmissionEdits, verifyRpcEdits } = await import("@/libs/blockchain/validation/editBinding")
const { OS, PEER, SENDER, demos, onTheWire } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { TLSN_DISABLED_REFUSAL, carriesTlsn, tlsnDisabledAt, tlsnDisabledRefusal } = await import("./tlsnDisabledGate")

restoreForkConfigAfterEach()

const service = () => {
    demos.connected = true
    return new TLSNotaryService(demos) as any
}
const request = async (): Promise<Transaction> =>
    onTheWire(await service().createTlsnRequestTransaction("https://example.com/path", 8))
const store = async (): Promise<Transaction> =>
    onTheWire(await service().createTlsnStoreTransaction("token-1", "proof-bytes", "onchain", 2n * OS, 8))
const tlsnTxs = async () => [await request(), await store()]
const pay = async () => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

/** The mainnet forks, with tlsnDisabled at `height`. */
const disabled = (height: number | null) => mainnetForks({ tlsnDisabled: height })

describeForkConfig("tlsnDisabled")

describe("tlsnDisabled operations", () => {
    it("matches a native tlsn_request or tlsn_store and a tlsnotary edit, nothing else", async () => {
        for (const tx of await tlsnTxs()) expect(carriesTlsn(tx)).toBe(true)
        expect(carriesTlsn(await pay())).toBe(false)
        const withRow = await pay()
        ;(withRow.content.gcr_edits as unknown[]).push({ type: "tlsnotary", operation: "store", account: SENDER })
        expect(carriesTlsn(withRow)).toBe(true)
        expect(carriesTlsn({ content: { type: "identity", data: ["identity", { nativeOperation: "tlsn_request" }] } })).toBe(false)
        expect(carriesTlsn({})).toBe(false)
    })

    it("refuses only while the fork is active, from the tip it is pinned at", async () => {
        disabled(50)
        expect(tlsnDisabledAt(49)).toBe(false)
        expect(tlsnDisabledAt(50)).toBe(true)
        const tx = await request()
        expect(tlsnDisabledRefusal(tx, false)).toBeNull()
        expect(tlsnDisabledRefusal(tx, true)).toBe(TLSN_DISABLED_REFUSAL)
    })
})

describe("intake", () => {
    it("pool admission refuses a request and a store", async () => {
        disabled(0)
        for (const tx of await tlsnTxs()) {
            expect(await verifyAdmissionEdits(tx)).toEqual({ ok: false, reason: TLSN_DISABLED_REFUSAL })
        }
    })

    it("RPC submission refuses them too", async () => {
        disabled(0)
        for (const tx of await tlsnTxs()) {
            expect(await verifyRpcEdits(tx)).toEqual({ ok: false, reason: TLSN_DISABLED_REFUSAL })
        }
    })

    it("admits a native send while the fork is active", async () => {
        disabled(0)
        expect(await verifyAdmissionEdits(await pay())).toEqual({ ok: true })
    })

    it("does not refuse them for TLSNotary while the fork is dormant", async () => {
        disabled(null)
        for (const tx of await tlsnTxs()) {
            expect((await verifyRpcEdits(tx)).reason).not.toBe(TLSN_DISABLED_REFUSAL)
        }
    })
})

describe("apply", () => {
    const block = stubBlockApply(handleGCR)
    const sender = () => block.caches.accounts.get(SENDER) as any

    it("refuses a request and a store in the block pre-pass, with no fee, burn or nonce", async () => {
        disabled(0)
        const txs = await tlsnTxs()
        const good = await pay()
        expect(await block.refused([...txs, good])).toEqual(txs.map(tx => tx.hash))

        const out = await block.apply(txs)
        expect(out.failedTxs.sort()).toEqual(txs.map(tx => tx.hash).sort())
        expect(out.successfulTxs).toEqual([])
        expect(sender().balance).toBe(SENDER_BALANCE)
        expect(sender().nonce).toBe(7)
        expect(block.caches.tlsNotaries.size).toBe(0)
    })

    it("judges the fork from the tip, like the other apply gates", async () => {
        disabled(101)
        const tx = await request()
        expect(await block.refused([tx])).toEqual([])
        chainTip.height = 101
        expect(await block.refused([tx])).toEqual([tx.hash])
    })

    it("refuses the simulation before its edits, so no fee is debited and no token is issued", async () => {
        issuedTokens.length = 0
        disabled(0)
        const tx = await request()

        const out = await handleGCR.applyTransaction(block.caches, tx, false, true)

        expect(out).toMatchObject({ success: false, message: TLSN_DISABLED_REFUSAL, appliedEditsCount: 0, unproven: true })
        expect(issuedTokens).toEqual([])
        expect(sender().balance).toBe(SENDER_BALANCE)
    })

    it("issues the token in the simulation while the fork is dormant", async () => {
        issuedTokens.length = 0
        disabled(null)
        await handleGCR.applyTransaction(block.caches, await request(), false, true)
        expect(issuedTokens).toHaveLength(1)
    })
})
