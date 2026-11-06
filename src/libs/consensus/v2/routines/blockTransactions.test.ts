/**
 * Under `blockCaps` the block's share of the pool is chosen among the txs
 * that can enter it, so a tx waiting on a missing nonce does not take a
 * slot a ready tx could use.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

jest.mock("src/utilities/sharedState", () => ({
    getSharedState: { lastBlockNumber: 100, referenceBlockRoom: 1 },
}))

let accountNonces: Record<string, number> = {}
jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonces: jest.fn(async () => ({ ...accountNonces })),
    },
}))

import { judgeBlockTransactions } from "./blockTransactions"
import { orderDeterministically } from "./deterministicOrder"

const account = (i: number) => "0x" + i.toString(16).padStart(64, "0")

function tx(from: number, nonce: number) {
    return {
        hash: `0x${from.toString(16).padStart(4, "0")}${nonce.toString(16).padStart(4, "0")}`,
        status: "pending",
        reference_block: 100,
        content: {
            type: "native",
            from: account(from),
            from_ed25519_address: account(from),
            nonce,
            gcr_edits: [{ type: "nonce", account: account(from) }],
        },
    } as any
}

const CAPS = { maxTxs: 3, maxContentBytes: 1024 * 1024 }

describe("judgeBlockTransactions under blockCaps", () => {
    beforeEach(() => {
        accountNonces = {}
    })

    it("fills the block with ready txs while waiting txs are pooled", async () => {
        // Senders 0-9 skip a nonce; 10-12 are ready.
        const pool: any[] = []
        for (let s = 0; s < 13; s++) {
            accountNonces[account(s)] = 0
            pool.push(tx(s, s < 10 ? 2 : 1))
        }
        const ordered = orderDeterministically(pool)

        for (const height of [101, 102, 103]) {
            const block = await judgeBlockTransactions(ordered, height, {
                capped: true,
                osDenominationActive: true,
                caps: CAPS,
            })
            expect(block.txs.map(t => t.content.from).sort()).toEqual(
                [account(10), account(11), account(12)],
            )
        }
    })

    it("projects nonces for the txs the block takes, not the whole pool", async () => {
        accountNonces[account(1)] = 0
        const ordered = orderDeterministically([1, 2, 3, 4, 5].map(n => tx(1, n)))
        const block = await judgeBlockTransactions(ordered, 101, {
            capped: true,
            osDenominationActive: true,
            caps: CAPS,
        })
        expect(block.txs.map(t => t.content.nonce)).toEqual([1, 2, 3])
        expect(block.nonce.projectedEndNonces[account(1)]).toBe(3)
        expect(block.failedTxs).toEqual([])
    })

    it("judges the whole pool before the fork", async () => {
        accountNonces[account(1)] = 0
        const ordered = orderDeterministically([1, 2, 3, 4, 5].map(n => tx(1, n)))
        const block = await judgeBlockTransactions(ordered, 101, {
            capped: false,
            osDenominationActive: true,
            caps: CAPS,
        })
        expect(block.txs).toHaveLength(5)
    })
})
