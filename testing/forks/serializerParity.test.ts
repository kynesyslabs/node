/**
 * The RPC coherence check (Transaction.isCoherent, via the fork-aware gate)
 * and the mempool validator (validateTxCoherence) must derive the same hash
 * from the same content. If they serialize differently on any field, one
 * ingress admits what the other rejects, and peers disagree on hashes at
 * block time.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import { serializeTransactionContent } from "@/forks/serializerGate"
import { serializeTxContent } from "@/libs/crypto/txContentSerializer"
import { validateTxCoherence } from "@/libs/blockchain/validation/txValidator"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import TransactionClass from "@/libs/blockchain/transaction"
import type { Transaction, TransactionContent } from "@kynesyslabs/demosdk/types"

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

function content(overrides: Record<string, unknown> = {}): TransactionContent {
    return {
        type: "native",
        from: "0x" + "ab".repeat(32),
        from_ed25519_address: "0x" + "ab".repeat(32),
        to: "0x" + "ef".repeat(32),
        amount: 100,
        data: ["native", { description: "transfer" }],
        gcr_edits: [],
        nonce: 3,
        timestamp: 1_760_000_000_000,
        transaction_fee: {
            network_fee: 1,
            rpc_fee: 2,
            additional_fee: 3,
            rpc_address: null,
        },
        ...overrides,
    } as unknown as TransactionContent
}

// Shapes where a re-implemented serializer is most likely to drift: extra and
// reordered fee keys, a missing rpc_address, and amounts inside gcr_edits.
const FEE_WITH_EXTRA_KEY = {
    additional_fee: 3,
    network_fee: 1,
    rpc_fee: 2,
    rpc_address: "0x" + "12".repeat(32),
    surcharge_note: "kept verbatim",
}
const FEE_WITHOUT_RPC_ADDRESS = { network_fee: 1, rpc_fee: 2, additional_fee: 3 }
const EDITS_WITH_AMOUNTS = [
    {
        type: "balance",
        operation: "remove",
        account: "0x" + "ab".repeat(32),
        amount: 100,
        txhash: "",
        isRollback: false,
    },
    {
        type: "balance",
        operation: "add",
        account: "0x" + "ef".repeat(32),
        amount: 100,
        txhash: "",
        isRollback: false,
    },
]

const SHAPES: Array<[string, TransactionContent]> = [
    ["standard", content()],
    ["fee with an extra key and non-standard order", content({ transaction_fee: FEE_WITH_EXTRA_KEY })],
    ["fee without rpc_address", content({ transaction_fee: FEE_WITHOUT_RPC_ADDRESS })],
    ["gcr_edits carrying DEM-number amounts", content({ gcr_edits: EDITS_WITH_AMOUNTS })],
    [
        "both together",
        content({ transaction_fee: FEE_WITH_EXTRA_KEY, gcr_edits: EDITS_WITH_AMOUNTS }),
    ],
]

describe("one transaction serializer for RPC and mempool", () => {
    let snapshot: ForkConfigByName
    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.forkConfig.osDenomination.activationHeight = 10
    })
    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    for (const [name, c] of SHAPES) {
        it(`${name}: RPC check and mempool validator derive the same hash, pre and post fork`, () => {
            for (const [height, postFork] of [
                [5, false],
                [10, true],
            ] as const) {
                const viaGate = serializeTransactionContent(c, height)
                expect(viaGate).toBe(serializeTxContent(c, postFork))

                const tx = { hash: sha256(viaGate), content: c } as unknown as Transaction
                expect(validateTxCoherence(tx, postFork).valid).toBe(true)
                // The RPC ingress check, at the same height.
                expect(TransactionClass.isCoherent(tx, height)).toBe(true)
            }
        })
    }

    it("keeps a non-standard fee as the signer wrote it, post-fork", () => {
        const wire = JSON.parse(
            serializeTransactionContent(content({ transaction_fee: FEE_WITH_EXTRA_KEY }), 10),
        )
        expect(Object.keys(wire.transaction_fee)).toEqual([
            "additional_fee",
            "network_fee",
            "rpc_fee",
            "rpc_address",
            "surcharge_note",
        ])
        expect(wire.transaction_fee.network_fee).toBe("1000000000")
        expect(wire.transaction_fee.surcharge_note).toBe("kept verbatim")
    })

    it("rejects, instead of throwing, content the serializer cannot canonicalize", () => {
        const nullFee = content({
            transaction_fee: {
                network_fee: null,
                rpc_fee: 2,
                additional_fee: 3,
                rpc_address: null,
            },
        })
        const tx = { hash: "00".repeat(32), content: nullFee } as unknown as Transaction

        const verdict = validateTxCoherence(tx, true)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("cannot be serialized")

        const rpc = TransactionClass.checkCoherence(tx, 10)
        expect(rpc.coherent).toBe(false)
        expect(rpc.reason).toContain("cannot be serialized")
        expect(TransactionClass.isCoherent(tx, 10)).toBe(false)
    })

    it("does not invent a null rpc_address the signer never wrote", () => {
        const wire = JSON.parse(
            serializeTransactionContent(content({ transaction_fee: FEE_WITHOUT_RPC_ADDRESS }), 10),
        )
        expect("rpc_address" in wire.transaction_fee).toBe(false)
    })

    it("canonicalises gcr_edits amounts post-fork and leaves them alone pre-fork", () => {
        const c = content({ gcr_edits: EDITS_WITH_AMOUNTS })
        const post = JSON.parse(serializeTransactionContent(c, 10))
        expect(post.gcr_edits.map((e: any) => e.amount)).toEqual([
            "100000000000",
            "100000000000",
        ])
        const pre = JSON.parse(serializeTransactionContent(c, 5))
        expect(pre.gcr_edits.map((e: any) => e.amount)).toEqual([100, 100])
    })

    it("pre-fork output is the raw JSON the chain has always hashed", () => {
        for (const [, c] of SHAPES) {
            expect(serializeTransactionContent(c, 5)).toBe(JSON.stringify(c))
        }
    })
})
