/**
 * The requester's package for #1059 (PATH-OS, 2026-10-15) against the status
 * call: N07's included-but-failed transfer read through the stored row, F04's
 * client rules applied to what the node now answers, F02's field types, and
 * N01's "a 502 says nothing" against the distinct not-found, unsynced and
 * lookup-failed answers. The head call is in requesterFixtures.head.test.ts.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { mockTransactionStore } from "src/libs/blockchain/transactionStoreMocks"

const getLastBlockNumber = jest.fn(async () => 0)
const { findOneBy, findByHash } = mockTransactionStore()

// The stored-row read is the real one; only the database under it is faked.
const txOps = await import("src/libs/blockchain/chainTransactions")
const { getSharedState: sharedState } = await import("src/utilities/sharedState")
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getTransactionStatus: txOps.getTransactionStatus, getLastBlockNumber },
}))

const { default: getTransactionStatus } = await import("./getTransactionStatus")

const FIXTURES = join(import.meta.dir, "../../../blockchain/finality/__fixtures__/requester-1059-1060")
const load = (path: string) => JSON.parse(readFileSync(join(FIXTURES, path), "utf8"))

const F02 = load("fixtures/F02_node_method_shapes_20260907.json")
const F04 = load("fixtures/F04_existing_api_readback_composition.json")
const N01 = load("negative/N01_gateway_http502_window_20261014.json")
const N07 = load("negative/N07_included_but_failed_public_record.json")

const reported = N07["reported_responses (quoted from the public records, not re-captured)"]
const N07_HASH: string = N07.tx
const N07_BLOCK: number = N07.block
const N07_CODE: string = reported["getTxByHash (excerpt)"].attrs.code
/** Testnet height when #1059 was filed; the node has searched through it. */
const HEAD = 529_479

function storedRow(status: string, attrs: Record<string, unknown> | null = null) {
    return {
        blockNumber: N07_BLOCK,
        signature: JSON.stringify({ type: "ed25519", data: "00" }),
        status,
        hash: N07_HASH,
        content: JSON.stringify({ type: "native", from: "0xa", to: "0xb", amount: 9 }),
        type: "native",
        from: "0xa",
        to: "0xb",
        from_ed25519_address: null,
        amount: 9n,
        nonce: "3",
        timestamp: "1760000000000",
        networkFee: 0n,
        rpcFee: 0n,
        additionalFee: 0n,
        ed25519_signature: null,
        attrs,
    }
}

/**
 * F04 step 3, as the requester's client applies it: accept only `included`
 * at the block getTxByHash names; everything else is indeterminate.
 */
function f04StatusStep(answer: { state?: unknown; blockNumber?: unknown }, txBlockNumber: number): "included" | "indeterminate" {
    return answer.state === "included" && answer.blockNumber === txBlockNumber ? "included" : "indeterminate"
}

beforeEach(() => {
    for (const fn of [findOneBy, findByHash, getLastBlockNumber]) fn.mockReset()
    findOneBy.mockResolvedValue(null)
    findByHash.mockResolvedValue(null)
    getLastBlockNumber.mockResolvedValue(HEAD)
    sharedState.syncStatus = true
    sharedState.inSyncLoop = false
    sharedState.forkConfig = undefined as never
})

describe("N07, #1059 acceptance test 2: included but failed", () => {
    it("was reported included by the deployed node", () => {
        expect(reported.getTransactionStatus).toEqual({ state: "included", blockNumber: N07_BLOCK })
        expect(N07_CODE).toBe("TX_NONCE_INVALID_LOW")
    })

    it("is now answered failed, with its code, block and the height searched", async () => {
        findOneBy.mockResolvedValue(storedRow("failed", { code: N07_CODE, message: "Nonce too low" }))
        const reply = await getTransactionStatus({ hash: N07_HASH })
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual({
            state: "failed",
            blockNumber: N07_BLOCK,
            code: N07_CODE,
            message: "Nonce too low",
            checkedThroughBlock: HEAD,
        })
    })

    it("keeps the types F02 recorded for state and blockNumber", async () => {
        const types: Record<string, string> = F02.top_level_field_types_checked.getTransactionStatus
        findOneBy.mockResolvedValue(storedRow("failed", { code: N07_CODE }))
        const { response } = await getTransactionStatus({ hash: N07_HASH })
        for (const [field, type] of Object.entries(types)) expect([field, typeof response[field]]).toEqual([field, type])
        expect(typeof response.checkedThroughBlock).toBe("number")
    })
})

describe("F04 step 3: the requester's client rule against today's answers", () => {
    it("names the rule this test applies", () => {
        expect(F04.call_sequence[2].checks).toEqual([
            "state == included, else indeterminate (failed/rejected/unknown/pending are never accepted)",
            "blockNumber equals the getTxByHash blockNumber",
        ])
    })

    it("accepts an executed transfer and never N07's", async () => {
        findOneBy.mockResolvedValue(storedRow("confirmed"))
        expect(f04StatusStep((await getTransactionStatus({ hash: N07_HASH })).response, N07_BLOCK)).toBe("included")

        findOneBy.mockResolvedValue(storedRow("failed", { code: N07_CODE }))
        expect(f04StatusStep((await getTransactionStatus({ hash: N07_HASH })).response, N07_BLOCK)).toBe("indeterminate")
    })

    it("leaves pending and unknown indeterminate", async () => {
        findByHash.mockResolvedValue({ hash: N07_HASH })
        const pending = await getTransactionStatus({ hash: N07_HASH })
        expect(pending.response.state).toBe("pending")
        expect(f04StatusStep(pending.response, N07_BLOCK)).toBe("indeterminate")

        findByHash.mockResolvedValue(null)
        const unknown = await getTransactionStatus({ hash: N07_HASH })
        expect(unknown.response.state).toBe("unknown")
        expect(f04StatusStep(unknown.response, N07_BLOCK)).toBe("indeterminate")
    })
})

describe("N01, #1059 acceptance test 5: not found, unsynced and lookup failure are distinct", () => {
    it("records gateway 502s that carry no height or reason", () => {
        expect(N01.http_502).toBe(N01.probes)
        expect(N01.successful_probes).toBe(0)
    })

    it("answers 404 not_found and 503 node_not_synced, each with the height searched, and 500 lookup_failed", async () => {
        const notFound = await getTransactionStatus({ hash: N07_HASH })
        sharedState.syncStatus = false
        const unsynced = await getTransactionStatus({ hash: N07_HASH })
        sharedState.syncStatus = true
        findOneBy.mockRejectedValue(new Error("connection terminated"))
        const failed = await getTransactionStatus({ hash: N07_HASH })

        expect([notFound.result, notFound.extra]).toEqual([404, { reason: "not_found" }])
        expect(notFound.response).toEqual({ state: "unknown", checkedThroughBlock: HEAD })
        expect([unsynced.result, unsynced.extra]).toEqual([503, { reason: "node_not_synced" }])
        expect(unsynced.response).toEqual({ state: "unknown", checkedThroughBlock: HEAD })
        expect(failed.result).toBe(500)
        expect(failed.extra).toMatchObject({ reason: "lookup_failed" })
    })
})
