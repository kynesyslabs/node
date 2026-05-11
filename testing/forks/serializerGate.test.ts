/**
 * Bit-identical regression test for the serializer gate (default config).
 *
 * Contract (SPEC.md §3 P2 / P3a): with every fork's `activationHeight`
 * defaulting to `null`, the serializer must return exactly
 * `JSON.stringify(content)`. This guarantees a node booting with the
 * default fork config is bit-identical to the pre-P2 / pre-P3a code path
 * — every existing transaction hash and block hash is preserved.
 *
 * If any of the "default config" tests below ever fails, the gate has a
 * bug — STOP and report.
 *
 * The fork-active expectations live in `postForkSerializer.test.ts`
 * (P3a transformations) and `forkBoundary.test.ts` (P3a height
 * dispatch).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
    serializeTransactionContent,
    serializeBlockContent,
} from "@/forks/serializerGate"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type {
    TransactionContent,
    BlockContent,
} from "@kynesyslabs/demosdk/types"

// REVIEW: A realistic-ish TransactionContent. Field shapes match the SDK
// type so the test exercises the same JSON paths as production code.
function makeSampleTransactionContent(): TransactionContent {
    return {
        type: "native",
        from: "0x" + "ab".repeat(32),
        from_ed25519_address: "0x" + "cd".repeat(32),
        to: "0x" + "ef".repeat(32),
        amount: 1234567890,
        data: ["native", { description: "transfer" }] as any,
        gcr_edits: [],
        nonce: 42,
        timestamp: 1_700_000_000_000,
        transaction_fee: {
            network_fee: 10,
            rpc_fee: 5,
            additional_fee: 0,
        },
    }
}

function makeSampleBlockContent(): BlockContent {
    return {
        ordered_transactions: ["0xdeadbeef", "0xcafef00d"],
        per_address_transactions: new Map(),
        web2data: {},
        previousHash: "0x" + "00".repeat(32),
        timestamp: 1_700_000_000_000,
        peerlist: [],
        l2ps_partecipating_nodes: new Map(),
        l2ps_banned_nodes: new Map(),
        encrypted_transactions_hashes: new Map(),
        native_tables_hashes: {
            native_gcr: "0x" + "11".repeat(32),
            native_subnets_txs: "0x" + "22".repeat(32),
            native_tlsnotary: "0x" + "33".repeat(32),
        },
    }
}

describe("serializerGate — bit-identical to JSON.stringify with default config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("transaction content: same bytes as JSON.stringify at any height (default config)", () => {
        const content = makeSampleTransactionContent()
        const direct = JSON.stringify(content)

        expect(serializeTransactionContent(content, 0)).toBe(direct)
        expect(serializeTransactionContent(content, 1)).toBe(direct)
        expect(serializeTransactionContent(content, 1_000_000)).toBe(direct)
        // Default: activationHeight === null → fork never active even at
        // absurdly high heights.
        expect(serializeTransactionContent(content, 999_999_999)).toBe(direct)
    })

    it("block content: same bytes as JSON.stringify at any height (default config)", () => {
        const content = makeSampleBlockContent()
        const direct = JSON.stringify(content)

        expect(serializeBlockContent(content, 0)).toBe(direct)
        expect(serializeBlockContent(content, 1)).toBe(direct)
        expect(serializeBlockContent(content, 1_000_000)).toBe(direct)
        expect(serializeBlockContent(content, 999_999_999)).toBe(direct)
    })

    it("block content: even with fork ACTIVE, branches are bit-identical", () => {
        // BlockContent has no amount/fee fields, so the post-fork branch
        // must remain a no-op. This is the explicit P3a contract for
        // blocks (see comment in `serializerGate.ts#serializeBlockContent`).
        getSharedState.forkConfig.osDenomination.activationHeight = 0
        const content = makeSampleBlockContent()
        const direct = JSON.stringify(content)

        expect(serializeBlockContent(content, 0)).toBe(direct)
        expect(serializeBlockContent(content, 1)).toBe(direct)
        expect(serializeBlockContent(content, 1_000_000)).toBe(direct)
    })

    it("transaction content: pre-fork branch unchanged at the gating boundary", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 100
        const content = makeSampleTransactionContent()
        const direct = JSON.stringify(content)

        // Just below the boundary (legacy branch) → must equal the
        // legacy bytes verbatim.
        expect(serializeTransactionContent(content, 99)).toBe(direct)
        expect(serializeTransactionContent(content, 0)).toBe(direct)
    })
})
