import { beforeAll, describe, expect, it, mock } from "bun:test"

import { installFakeBlockDatabase, stubBlockInsertCollaborators } from "./blockInsert.fixtures"

/**
 * MempoolStuck reads rate(demos_transactions_total): a stored block must
 * count its transactions there, or the rate is 0 on a healthy node and the
 * alert can only ever be silent or wrong.
 */

installFakeBlockDatabase(() => {})
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))
await stubBlockInsertCollaborators()
const { insertBlock } = await import("./chainBlocks")
const { getSharedState } = await import("src/utilities/sharedState")
const { getMetricsService } = await import("@/features/metrics/MetricsService")

getSharedState.forkConfig = {
    ...getSharedState.forkConfig,
    osDenomination: { activationHeight: null },
    gasFeeSeparation: { activationHeight: null },
} as any

const tx = (hash: string, status: "confirmed" | "failed"): any => ({
    hash,
    status,
    signature: null,
    ed25519_signature: null,
    content: {
        type: "native",
        from: "0xaa",
        to: "0xbb",
        from_ed25519_address: "0xaa",
        amount: "1",
        nonce: 1,
        timestamp: 1_700_000_000,
        transaction_fee: { network_fee: "0", rpc_fee: "0", additional_fee: "0" },
        data: ["native", {}],
        gcr_edits: [],
    },
})

const block = (number: number, hashes: string[]): any => ({
    number,
    hash: `0xblock${number}`,
    proposer: "ab".repeat(32),
    next_proposer: "cd".repeat(32),
    status: "confirmed",
    validation_data: { signatures: {} },
    content: { ordered_transactions: hashes, timestamp: 1_700_000_000 },
    attrs: {},
})

async function included(status: string): Promise<number> {
    const text = await getMetricsService().getMetrics()
    const line = text
        .split("\n")
        .find(l => l.startsWith("demos_transactions_total{") && l.includes(`status="${status}"`))
    return line ? Number(line.split(" ").pop()) : NaN
}

beforeAll(async () => {
    await getMetricsService().initialize()
    getSharedState.lastBlockNumber = 0
})

describe("demos_transactions_total", () => {
    it("exists at 0 before any block is stored", async () => {
        expect(await included("confirmed")).toBe(0)
        expect(await included("failed")).toBe(0)
    })

    it("counts each stored block's transactions by final status", async () => {
        await insertBlock(block(1, ["0x1", "0x2", "0x3"]), [
            tx("0x1", "confirmed"),
            tx("0x2", "confirmed"),
            tx("0x3", "failed"),
        ])
        expect(await included("confirmed")).toBe(2)
        expect(await included("failed")).toBe(1)
    })
})
