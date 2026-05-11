/**
 * Post-fork serializer tests (P3a).
 *
 * Validates the P3a contract for {@link serializeTransactionContent}
 * once the `osDenomination` fork is active:
 *
 *  1. **Amount conversion** — `amount: number` (DEM) becomes
 *     `amount: "<OS>"` on the wire.
 *  2. **Fee conversion** — `transaction_fee.network_fee`, `rpc_fee`,
 *     `additional_fee` follow the same rule.
 *  3. **Idempotency** — re-serialising a content whose `amount` is
 *     already an OS string yields the same canonical OS string (the
 *     transformation is a fixed-point on canonical post-fork inputs).
 *  4. **Key order preservation** — the post-fork JSON has the same
 *     `Object.keys` order as the pre-fork JSON for the same input.
 *     This is consensus-critical: hashes are insertion-order sensitive.
 *  5. **Hash distinctness** — pre-fork and post-fork serialisations of
 *     the same logical content produce different bytes (this is
 *     literally the point of the fork).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { serializeTransactionContent } from "@/forks/serializerGate"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"

// REVIEW: Mirrors the fixture in serializerGate.test.ts so the two
// suites share the same assumed wire shape. amount: 100 DEM is chosen
// because demToOs(100) === 100_000_000_000n, which exceeds Number.MAX_SAFE
// but parses cleanly as a base-10 string — a useful sanity check.
function makeSampleTransactionContent(
    overrides: Partial<TransactionContent> = {},
): TransactionContent {
    return {
        type: "native",
        from: "0x" + "ab".repeat(32),
        from_ed25519_address: "0x" + "cd".repeat(32),
        to: "0x" + "ef".repeat(32),
        amount: 100,
        data: ["native", { description: "transfer" }] as any,
        gcr_edits: [],
        nonce: 42,
        timestamp: 1_700_000_000_000,
        transaction_fee: {
            network_fee: 1,
            rpc_fee: 2,
            additional_fee: 3,
        },
        ...overrides,
    }
}

describe("serializerGate — post-fork transaction transformer (P3a)", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
        // Activate the fork at genesis for every test in this suite. The
        // height-dispatch behaviour is covered separately in
        // forkBoundary.test.ts.
        getSharedState.forkConfig.osDenomination.activationHeight = 0
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("converts top-level amount from DEM number to OS string", () => {
        const content = makeSampleTransactionContent({ amount: 100 })
        const wire = serializeTransactionContent(content, 0)
        const parsed = JSON.parse(wire)

        expect(parsed.amount).toBe("100000000000")
        expect(typeof parsed.amount).toBe("string")
    })

    it("converts every transaction_fee field from DEM number to OS string", () => {
        const content = makeSampleTransactionContent({
            transaction_fee: {
                network_fee: 1,
                rpc_fee: 2,
                additional_fee: 3,
            },
        })
        const wire = serializeTransactionContent(content, 0)
        const parsed = JSON.parse(wire)

        expect(parsed.transaction_fee.network_fee).toBe("1000000000")
        expect(parsed.transaction_fee.rpc_fee).toBe("2000000000")
        expect(parsed.transaction_fee.additional_fee).toBe("3000000000")
    })

    it("converts zero amount/fees correctly", () => {
        const content = makeSampleTransactionContent({
            amount: 0,
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
            },
        })
        const wire = serializeTransactionContent(content, 0)
        const parsed = JSON.parse(wire)

        expect(parsed.amount).toBe("0")
        expect(parsed.transaction_fee.network_fee).toBe("0")
        expect(parsed.transaction_fee.rpc_fee).toBe("0")
        expect(parsed.transaction_fee.additional_fee).toBe("0")
    })

    it("is idempotent when amount/fees are already canonical OS strings", () => {
        // Simulate a tx whose amount/fees were produced by a v3-class SDK
        // (already OS strings) and being re-hashed by the node post-fork.
        const content = makeSampleTransactionContent({
            // Cast through unknown — SDK v2 still types these as `number`.
            amount: "100000000000" as unknown as number,
            transaction_fee: {
                network_fee: "1000000000" as unknown as number,
                rpc_fee: "2000000000" as unknown as number,
                additional_fee: "3000000000" as unknown as number,
            },
        })

        const wire1 = serializeTransactionContent(content, 0)
        const parsed1 = JSON.parse(wire1)

        expect(parsed1.amount).toBe("100000000000")
        expect(parsed1.transaction_fee.network_fee).toBe("1000000000")
        expect(parsed1.transaction_fee.rpc_fee).toBe("2000000000")
        expect(parsed1.transaction_fee.additional_fee).toBe("3000000000")

        // Round-trip: feeding the same logical content (now with strings)
        // back through the serializer must yield the same bytes.
        const wire2 = serializeTransactionContent(parsed1 as TransactionContent, 0)
        expect(wire2).toBe(wire1)
    })

    it("canonicalises non-canonical OS strings (defence in depth)", () => {
        // The SDK should never emit "00100" but the serializer is the
        // boundary where consensus byte-equality is enforced. Re-parse
        // and re-emit in canonical form.
        const content = makeSampleTransactionContent({
            amount: "00100" as unknown as number,
        })
        const wire = serializeTransactionContent(content, 0)
        const parsed = JSON.parse(wire)
        expect(parsed.amount).toBe("100")
    })

    it("preserves Object.keys order between pre-fork and post-fork wire JSON", () => {
        // Consensus-critical: JSON.stringify is insertion-order
        // sensitive. The post-fork transformer must preserve the same
        // top-level (and transaction_fee) key insertion order as the
        // pre-fork content.
        const content = makeSampleTransactionContent()

        getSharedState.forkConfig.osDenomination.activationHeight = null
        const preForkWire = serializeTransactionContent(content, 0)

        getSharedState.forkConfig.osDenomination.activationHeight = 0
        const postForkWire = serializeTransactionContent(content, 0)

        const preKeys = Object.keys(JSON.parse(preForkWire))
        const postKeys = Object.keys(JSON.parse(postForkWire))
        expect(postKeys).toEqual(preKeys)

        const preFeeKeys = Object.keys(JSON.parse(preForkWire).transaction_fee)
        const postFeeKeys = Object.keys(
            JSON.parse(postForkWire).transaction_fee,
        )
        expect(postFeeKeys).toEqual(preFeeKeys)
    })

    it("preserves all non-amount/fee fields verbatim", () => {
        const content = makeSampleTransactionContent()
        const wire = serializeTransactionContent(content, 0)
        const parsed = JSON.parse(wire)

        expect(parsed.type).toBe(content.type)
        expect(parsed.from).toBe(content.from)
        expect(parsed.from_ed25519_address).toBe(content.from_ed25519_address)
        expect(parsed.to).toBe(content.to)
        expect(parsed.data).toEqual(content.data)
        expect(parsed.gcr_edits).toEqual(content.gcr_edits)
        expect(parsed.nonce).toBe(content.nonce)
        expect(parsed.timestamp).toBe(content.timestamp)
    })

    it("pre-fork and post-fork wire bytes differ for the same logical content", () => {
        // The whole point of the fork: the same DEM-number amount
        // serialises to different bytes pre- vs post-fork, so signatures
        // committed against one set of bytes do not validate against the
        // other.
        const content = makeSampleTransactionContent()

        getSharedState.forkConfig.osDenomination.activationHeight = null
        const preForkWire = serializeTransactionContent(content, 0)

        getSharedState.forkConfig.osDenomination.activationHeight = 0
        const postForkWire = serializeTransactionContent(content, 0)

        expect(postForkWire).not.toBe(preForkWire)
        expect(preForkWire.includes("\"amount\":100")).toBe(true)
        expect(postForkWire.includes("\"amount\":\"100000000000\"")).toBe(true)
    })

    it("does not mutate the input content", () => {
        const content = makeSampleTransactionContent({ amount: 100 })
        const before = JSON.stringify(content)
        getSharedState.forkConfig.osDenomination.activationHeight = 0
        serializeTransactionContent(content, 0)
        const after = JSON.stringify(content)
        // Pre-fork bytes still contain the unmodified DEM number.
        expect(after).toBe(before)
        expect(content.amount).toBe(100)
        expect(content.transaction_fee.network_fee).toBe(1)
    })
})
