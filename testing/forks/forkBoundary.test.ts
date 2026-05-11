/**
 * Fork-height boundary dispatch test (P3a).
 *
 * Validates that {@link serializeTransactionContent} dispatches between
 * the legacy and post-fork branches based purely on
 * `blockHeight >= activationHeight`. Specifically:
 *
 *  - At height N-1 (one below activation): legacy bytes.
 *  - At height N (activation): post-fork bytes.
 *  - At height N+k (above activation): post-fork bytes.
 *  - The same logical content yields different bytes at heights
 *    straddling the activation boundary, which is exactly the property
 *    that makes a hard fork a fork (signatures committed pre-fork do
 *    not validate post-fork and vice versa).
 *
 * Block content is intentionally not exercised here: P3a's
 * `serializeBlockContent` is a no-op for `osDenomination` because
 * `BlockContent` has no amount/fee fields. The `serializerGate.test.ts`
 * suite already pins that property explicitly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { serializeTransactionContent } from "@/forks/serializerGate"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"

function makeSampleTransactionContent(): TransactionContent {
    return {
        type: "native",
        from: "0x" + "ab".repeat(32),
        from_ed25519_address: "0x" + "cd".repeat(32),
        to: "0x" + "ef".repeat(32),
        amount: 7,
        data: ["native", { description: "boundary" }] as any,
        gcr_edits: [],
        nonce: 1,
        timestamp: 1_700_000_000_000,
        transaction_fee: {
            network_fee: 1,
            rpc_fee: 1,
            additional_fee: 1,
            rpc_address: null,
        },
    }
}

describe("serializerGate — fork-height boundary dispatch (P3a)", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
        // Activate at height 100 for boundary inspection.
        getSharedState.forkConfig.osDenomination.activationHeight = 100
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("uses the legacy serializer at height N-1", () => {
        const content = makeSampleTransactionContent()
        const wire = serializeTransactionContent(content, 99)
        const parsed = JSON.parse(wire)
        expect(parsed.amount).toBe(7)
        expect(typeof parsed.amount).toBe("number")
    })

    it("uses the post-fork serializer at height N (activation)", () => {
        const content = makeSampleTransactionContent()
        const wire = serializeTransactionContent(content, 100)
        const parsed = JSON.parse(wire)
        expect(parsed.amount).toBe("7000000000")
        expect(typeof parsed.amount).toBe("string")
    })

    it("uses the post-fork serializer at height N+1", () => {
        const content = makeSampleTransactionContent()
        const wire = serializeTransactionContent(content, 101)
        const parsed = JSON.parse(wire)
        expect(parsed.amount).toBe("7000000000")
    })

    it("the same content hashes differently across the boundary", () => {
        // The whole reason this is a *hard* fork: bytes committed by a
        // signer at N-1 do not match bytes derived at N for the same
        // logical content. This is what forces all nodes to switch
        // serializers in lockstep at the activation height.
        const content = makeSampleTransactionContent()

        const beforeBoundary = serializeTransactionContent(content, 99)
        const atBoundary = serializeTransactionContent(content, 100)
        const afterBoundary = serializeTransactionContent(content, 101)

        expect(beforeBoundary).not.toBe(atBoundary)
        expect(atBoundary).toBe(afterBoundary)
    })

    it("converts transaction_fee at the boundary too", () => {
        const content = makeSampleTransactionContent()
        const preBoundary = JSON.parse(
            serializeTransactionContent(content, 99),
        )
        const postBoundary = JSON.parse(
            serializeTransactionContent(content, 100),
        )

        // Pre-fork: fees are still numbers in DEM units.
        expect(preBoundary.transaction_fee.network_fee).toBe(1)
        expect(preBoundary.transaction_fee.rpc_fee).toBe(1)
        expect(preBoundary.transaction_fee.additional_fee).toBe(1)

        // Post-fork: fees become OS strings.
        expect(postBoundary.transaction_fee.network_fee).toBe("1000000000")
        expect(postBoundary.transaction_fee.rpc_fee).toBe("1000000000")
        expect(postBoundary.transaction_fee.additional_fee).toBe("1000000000")
    })

    it("a null activationHeight keeps the gate inactive at every height", () => {
        // Reset the suite-level override: prove that null activation
        // never selects the post-fork branch.
        getSharedState.forkConfig.osDenomination.activationHeight = null

        const content = makeSampleTransactionContent()
        const direct = JSON.stringify(content)

        expect(serializeTransactionContent(content, 0)).toBe(direct)
        expect(serializeTransactionContent(content, 100)).toBe(direct)
        expect(serializeTransactionContent(content, 1_000_000)).toBe(direct)
    })
})
