import { describe, it, expect, mock, beforeEach } from "bun:test"
import type { Block, Transaction } from "@kynesyslabs/demosdk/types"

import Hashing from "src/libs/crypto/hashing"
import { serializeBlockContent } from "@/forks/serializerGate"
import { getSharedState } from "@/utilities/sharedState"

const SIGNER = "aa".repeat(32)
const NOW = 2_000

// Everything verifyBlock reads from the chain and the consensus pool is
// replaced; the transaction check it delegates to is the real one, with the
// pool's validator answering valid so only the "were txs supplied" logic and
// the block-listing rules decide.
mock.module("../chain", () => ({
    default: {
        getBlockByNumber: async (n: number) => ({
            number: n,
            hash: `hash-${n}`,
            content: { timestamp: 1_000 },
        }),
    },
}))
mock.module("src/libs/consensus/v2/routines/getShard", () => ({
    getEligiblePool: async () => [SIGNER],
}))
mock.module("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => NOW,
}))
mock.module("./txValidatorPool", () => ({
    default: {
        getInstance: () => ({
            verify: async () => true,
            validate: async (txs: Transaction[]) =>
                txs.map(tx => ({ hash: tx.hash, valid: true })),
        }),
    },
}))

const { verifyBlock } = await import("./verifyBlock")

function blockListing(hashes: string[]): Block {
    const content: any = {
        previousHash: "hash-4",
        timestamp: NOW,
        ordered_transactions: hashes,
    }
    const number = 5
    const hash = Hashing.sha256(serializeBlockContent(content, number))
    return {
        number,
        hash,
        content,
        validation_data: { signatures: { [SIGNER]: "0x00" } },
    } as unknown as Block
}

const tx = (hash: string) => ({ hash }) as unknown as Transaction

describe("verifyBlock transaction re-check", () => {
    beforeEach(() => {
        getSharedState.setShardSizeFromGenesis(4)
    })

    it("does not look at transactions when none are supplied", async () => {
        const block = blockListing(["11".repeat(32)])

        expect((await verifyBlock(block)).valid).toBe(true)
    })

    it("treats an empty list as supplied: a block that lists transactions fails", async () => {
        const block = blockListing(["11".repeat(32)])

        const verdict = await verifyBlock(block, [])

        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("were not supplied")
    })

    it("accepts an empty list for an empty block", async () => {
        expect((await verifyBlock(blockListing([]), [])).valid).toBe(true)
    })

    it("accepts the exact set of listed transactions", async () => {
        const a = "11".repeat(32)
        const b = "22".repeat(32)

        expect(
            (await verifyBlock(blockListing([a, b]), [tx(b), tx(a)])).valid,
        ).toBe(true)
    })
})
