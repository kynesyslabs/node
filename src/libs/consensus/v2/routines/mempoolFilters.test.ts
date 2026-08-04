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
    getSharedState: {
        lastBlockNumber: 100,
        referenceBlockRoom: 1,
    },
}))

let accountNonces: Record<string, number> = {}

jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonces: jest.fn(async () => ({ ...accountNonces })),
    },
}))

import {
    filterMempoolByNonce,
    filterMempoolByRefBlock,
    type MempoolTransaction,
} from "./mempoolFilters"
import { ErrorCode } from "@/errors"
import { TRANSACTION_STATUS } from "@/utilities/constants"

// lastBlockNumber=100, referenceBlockRoom=1:
// inclusion window [99, 100], deep window cutoff 100 - 5*1 = 95.
const LAST_BLOCK = 100
const DEEP_CUTOFF = 95

const tx = (
    hash: string,
    referenceBlock: number,
    overrides: Partial<{
        status: string
        nonce: number
        gcr_edits: Array<{ type: string; account: string }>
    }> = {},
): MempoolTransaction =>
    ({
        hash,
        status: overrides.status ?? TRANSACTION_STATUS.PENDING,
        reference_block: referenceBlock,
        attrs: {},
        content: {
            nonce: overrides.nonce ?? 0,
            gcr_edits: overrides.gcr_edits ?? [],
        },
    }) as unknown as MempoolTransaction

describe("filterMempoolByRefBlock", () => {
    it("passes in-window txs through untouched", () => {
        const a = tx("0xa", LAST_BLOCK)
        const b = tx("0xb", LAST_BLOCK - 1)
        const res = filterMempoolByRefBlock([a, b], true)
        expect(res.validTxs).toEqual([a, b])
        expect(res.failedTxs).toEqual([])
        expect(a.status).toBe(TRANSACTION_STATUS.PENDING)
    })

    it("includes expired-in-deep-window txs as failed with attrs", () => {
        const expired = tx("0xexp", LAST_BLOCK - 3)
        const res = filterMempoolByRefBlock([expired], true)
        expect(res.validTxs).toEqual([expired])
        expect(res.failedTxs).toEqual([])
        expect(expired.status).toBe(TRANSACTION_STATUS.FAILED)
        expect(expired.attrs.code).toBe(
            ErrorCode.TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE,
        )
        expect(expired.attrs.reference_block).toBe(LAST_BLOCK - 3)
        expect(expired.attrs.message).toContain("Reference block expired")
    })

    it("includes the exact deep-window boundary and drops one below", () => {
        const atCutoff = tx("0xat", DEEP_CUTOFF)
        const below = tx("0xbelow", DEEP_CUTOFF - 1)
        const res = filterMempoolByRefBlock([atCutoff, below], true)
        expect(res.validTxs).toEqual([atCutoff])
        expect(atCutoff.status).toBe(TRANSACTION_STATUS.FAILED)
        expect(res.failedTxs).toHaveLength(1)
        expect(res.failedTxs[0].txhash).toBe("0xbelow")
        expect(res.failedTxs[0].code).toBe(
            ErrorCode.TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE,
        )
        expect(below.status).toBe(TRANSACTION_STATUS.PENDING)
    })

    it("never includes future-reference txs as failed", () => {
        const future = tx("0xfuture", LAST_BLOCK + 1)
        const res = filterMempoolByRefBlock([future], true)
        expect(res.validTxs).toEqual([])
        expect(res.failedTxs).toHaveLength(1)
        expect(res.failedTxs[0].txhash).toBe("0xfuture")
        expect(future.status).toBe(TRANSACTION_STATUS.PENDING)
    })

    it("keeps exclude semantics when includeExpiredAsFailed is false", () => {
        const expired = tx("0xexp", LAST_BLOCK - 3)
        const res = filterMempoolByRefBlock([expired], false)
        expect(res.validTxs).toEqual([])
        expect(res.failedTxs).toHaveLength(1)
        expect(res.failedTxs[0].txhash).toBe("0xexp")
        expect(expired.status).toBe(TRANSACTION_STATUS.PENDING)
    })

    it("defaults to exclude semantics when the flag is omitted", () => {
        const expired = tx("0xexp", LAST_BLOCK - 2)
        const res = filterMempoolByRefBlock([expired])
        expect(res.validTxs).toEqual([])
        expect(res.failedTxs).toHaveLength(1)
    })
})

describe("filterMempoolByNonce", () => {
    const ACCT = "0x" + "ab".repeat(32)

    beforeEach(() => {
        accountNonces = { [ACCT]: 5 }
    })

    const nonceTx = (hash: string, nonce: number, status?: string) =>
        tx(hash, LAST_BLOCK, {
            nonce,
            status,
            gcr_edits: [{ type: "nonce", account: ACCT }],
        })

    it("passes already-failed txs through without consuming a nonce slot", async () => {
        const failedExpired = nonceTx(
            "0xfailed",
            6,
            TRANSACTION_STATUS.FAILED,
        )
        const valid = nonceTx("0xvalid", 6)
        const res = await filterMempoolByNonce([failedExpired, valid])
        expect(res.validTxs).toEqual([failedExpired, valid])
        expect(res.failedTxs).toEqual([])
        expect(valid.status).toBe(TRANSACTION_STATUS.PENDING)
        expect(res.projectedEndNonces[ACCT]).toBe(6)
    })

    it("accepts sequential nonces and projects the account forward", async () => {
        const first = nonceTx("0x1", 6)
        const second = nonceTx("0x2", 7)
        const res = await filterMempoolByNonce([first, second])
        expect(res.validTxs).toEqual([first, second])
        expect(res.projectedEndNonces[ACCT]).toBe(7)
        expect(res.startFilterNonces[ACCT]).toBe(5)
        expect([...res.nonceAccounts]).toEqual([ACCT])
    })

    it("includes low-nonce txs as failed", async () => {
        const low = nonceTx("0xlow", 5)
        const res = await filterMempoolByNonce([low])
        expect(res.validTxs).toEqual([low])
        expect(low.status).toBe(TRANSACTION_STATUS.FAILED)
        expect(low.attrs.code).toBe(ErrorCode.TX_NONCE_INVALID_LOW)
        expect(res.projectedEndNonces[ACCT]).toBe(5)
    })

    it("excludes high-nonce txs, keeping them for a later round", async () => {
        const high = nonceTx("0xhigh", 8)
        const res = await filterMempoolByNonce([high])
        expect(res.validTxs).toEqual([])
        expect(res.failedTxs).toHaveLength(1)
        expect(res.failedTxs[0].code).toBe(ErrorCode.TX_NONCE_INVALID_HIGH)
        expect(high.status).toBe(TRANSACTION_STATUS.PENDING)
    })

    it("passes txs without nonce edits straight through", async () => {
        const plain = tx("0xplain", LAST_BLOCK)
        const res = await filterMempoolByNonce([plain])
        expect(res.validTxs).toEqual([plain])
        expect(res.failedTxs).toEqual([])
    })
})
