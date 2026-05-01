/**
 * Bit-identical regression test for the P2 serializer gate.
 *
 * Contract (SPEC.md §3 P2): landing P2 must not change the bytes produced
 * by any hash site. With every fork's `activationHeight` defaulting to
 * `null`, both the legacy and post-fork branches in
 * `serializerGate.ts` must return exactly `JSON.stringify(content)`.
 *
 * If this test ever fails, P2 has a bug — STOP and report.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
    serializeTransactionContent,
    serializeBlockContent,
} from "@/forks/serializerGate"
import {
    cloneDefaultForkConfig,
    type ForkConfig,
    type ForkName,
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

describe("serializerGate — bit-identical to JSON.stringify in P2", () => {
    let snapshot: Record<ForkName, ForkConfig>

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
        // P2 default: activationHeight === null → fork never active even at
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

    it("transaction content: even with fork ACTIVE, P2 placeholder branch is bit-identical", () => {
        // P2 contract: both branches return the same bytes. P3 is what
        // differentiates them. Setting an activation height proves we
        // didn't accidentally diverge in P2.
        getSharedState.forkConfig.osDenomination.activationHeight = 0
        const content = makeSampleTransactionContent()
        const direct = JSON.stringify(content)

        expect(serializeTransactionContent(content, 0)).toBe(direct)
        expect(serializeTransactionContent(content, 1)).toBe(direct)
        expect(serializeTransactionContent(content, 1_000_000)).toBe(direct)
    })

    it("block content: even with fork ACTIVE, P2 placeholder branch is bit-identical", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 0
        const content = makeSampleBlockContent()
        const direct = JSON.stringify(content)

        expect(serializeBlockContent(content, 0)).toBe(direct)
        expect(serializeBlockContent(content, 1)).toBe(direct)
        expect(serializeBlockContent(content, 1_000_000)).toBe(direct)
    })

    it("transaction content: legacy and post-fork branches return identical bytes for the same input", () => {
        const content = makeSampleTransactionContent()

        // Pre-fork (default config: activationHeight null)
        const preFork = serializeTransactionContent(content, 50)

        // Post-fork (activated at 0, evaluating at any height)
        getSharedState.forkConfig.osDenomination.activationHeight = 0
        const postFork = serializeTransactionContent(content, 50)

        expect(preFork).toBe(postFork)
    })

    it("transaction content: gating boundary preserves identity in P2", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 100
        const content = makeSampleTransactionContent()
        const direct = JSON.stringify(content)

        // Just below the boundary (legacy branch).
        expect(serializeTransactionContent(content, 99)).toBe(direct)
        // At and above the boundary (placeholder branch).
        expect(serializeTransactionContent(content, 100)).toBe(direct)
        expect(serializeTransactionContent(content, 101)).toBe(direct)
    })
})
