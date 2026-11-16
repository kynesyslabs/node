/**
 * Mainnet launches with TLSNotary off. Under `tlsnDisabled` a native
 * `tlsn_request` or `tlsn_store` is refused at RPC intake, pool admission and
 * apply before any of its edits run: it pays no fee, burns nothing and no
 * attestation token is issued.
 *
 * The transactions come from the real SDK builders (TLSNotaryService).
 */

import { describe, expect, it, mock } from "bun:test"
import { mockEntityDatasource } from "@/utilities/testSupport/coreMocks"

mockEntityDatasource()

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
    describeForkConfig,
    describeTxGate,
    mainnetForks,
    mockChainAndLogger,
    restoreForkConfigAfterEach,
    stubBlockApply,
} = await import("@/libs/blockchain/testSupport/forkGates")
mockChainAndLogger()

const handleGCR = (await import("@/libs/blockchain/gcr/handleGCR")).default
const { SENDER } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { pay, tlsnRequest, tlsnTxs } = await import("@/libs/blockchain/testSupport/featureGateTxs")
const { TLSN_DISABLED_REFUSAL, carriesTlsn, tlsnDisabledAt, tlsnDisabledRefusal } = await import("./tlsnDisabledGate")

restoreForkConfigAfterEach()

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
        const tx = await tlsnRequest()
        expect(tlsnDisabledRefusal(tx, false)).toBeNull()
        expect(tlsnDisabledRefusal(tx, true)).toBe(TLSN_DISABLED_REFUSAL)
    })
})

describeTxGate({
    fork: "tlsnDisabled",
    gated: "a TLSNotary request and store",
    refusal: TLSN_DISABLED_REFUSAL,
    txs: tlsnTxs,
    other: pay,
    handleGCR,
})

describe("the attestation token", () => {
    const block = stubBlockApply(handleGCR)

    it("is not issued by a refused simulation, and no fee is debited", async () => {
        issuedTokens.length = 0
        disabled(0)

        const out = await handleGCR.applyTransaction(block.caches, await tlsnRequest(), false, true)

        expect(out).toMatchObject({ success: false, message: TLSN_DISABLED_REFUSAL, appliedEditsCount: 0, unproven: true })
        expect(issuedTokens).toEqual([])
        expect((block.caches.accounts.get(SENDER) as any).balance).toBe(SENDER_BALANCE)
    })

    it("is issued in the simulation while the fork is dormant", async () => {
        issuedTokens.length = 0
        disabled(null)
        await handleGCR.applyTransaction(block.caches, await tlsnRequest(), false, true)
        expect(issuedTokens).toHaveLength(1)
    })
})
