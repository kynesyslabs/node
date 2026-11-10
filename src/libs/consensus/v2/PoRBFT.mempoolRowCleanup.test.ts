/** Persisted pool rows from an older node must be checked before proposal. */
import { afterEach, expect, it, mock, spyOn } from "bun:test"
import { mockLogger } from "@/utilities/testSupport/coreMocks"

mockLogger("src/utilities/logger")

const sent: string[][] = []
mock.module("./routines/mergeMempools", () => ({
    mergeMempools: async (pool: Array<{ hash: string }>) => {
        sent.push(pool.map(tx => tx.hash))
    },
}))

const { mergeAndOrderMempools } = await import("./PoRBFT")
const { default: Mempool } = await import("src/libs/blockchain/mempool")
const { default: Chain } = await import("src/libs/blockchain/chain")
const { default: SecretaryManager } = await import("./types/secretaryManager")
const { getSharedState } = await import("src/utilities/sharedState")
const { default: log } = await import("src/utilities/logger")

const ACCOUNT = "0x" + "ab".repeat(32)
function row(hash: string, to: string) {
    return {
        hash,
        content: {
            type: "instantMessaging",
            from: ACCOUNT,
            from_ed25519_address: ACCOUNT,
            to,
            amount: 0,
            data: ["instantMessaging", { targetId: to }],
            gcr_edits: [],
            nonce: 1,
            timestamp: 1000,
            transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
        },
        signature: { type: "ed25519", data: "00" },
        status: "",
        reference_block: 100,
    }
}

const originalRepo = Mempool.repo
afterEach(() => {
    Mempool.repo = originalRepo
    mock.restore()
})

it("deletes an old oversized row and proposes the valid stored row", async () => {
    getSharedState.lastBlockNumber = 100
    getSharedState.forkConfig = {} as never
    sent.length = 0
    const oversized = row("0x" + "11".repeat(32), "x".repeat(1100))
    const valid = row("0x" + "22".repeat(32), ACCOUNT)
    const stored = [oversized, valid]
    const deleted: string[] = []
    Mempool.repo = {
        find: async () => [...stored],
        delete: async (where: { hash: { value: string[] } }) => {
            const hashes = where.hash.value
            deleted.push(...hashes)
            for (const hash of hashes) {
                const index = stored.findIndex(tx => tx.hash === hash)
                if (index >= 0) stored.splice(index, 1)
            }
            return { affected: hashes.length }
        },
    } as never

    spyOn(Chain, "getExistingTransactionHashes").mockResolvedValue(new Set())
    spyOn(SecretaryManager, "getInstance").mockReturnValue({
        shard: { blockRef: 101 },
        ourValidatorPhase: { currentPhase: 0 },
        setOurValidatorPhase: async () => undefined,
        sendOurValidatorPhaseToSecretary: async () => undefined,
        resolveMergedPeerlist: async () => [],
    } as never)

    const result = await mergeAndOrderMempools([], 101)
    expect(deleted).toEqual([oversized.hash])
    expect(stored.map(tx => tx.hash)).toEqual([valid.hash])
    expect(sent).toEqual([[valid.hash]])
    expect(result.txs.map(tx => tx.hash)).toEqual([valid.hash])
    expect(log.warning).toHaveBeenCalledWith(expect.stringContaining(`${oversized.hash}: Transaction to is longer than`))
})

it("keeps valid rows in the round when row deletion fails", async () => {
    getSharedState.lastBlockNumber = 100
    getSharedState.forkConfig = {} as never
    sent.length = 0
    const oversized = row("0x" + "33".repeat(32), "x".repeat(1100))
    const valid = row("0x" + "44".repeat(32), ACCOUNT)
    const stored = [oversized, valid]
    Mempool.repo = {
        find: async () => [...stored],
        delete: async (where: { hash: { value: string[] } }) => {
            if (where.hash.value.includes(oversized.hash)) {
                throw new Error("storage unavailable")
            }
            return { affected: 0 }
        },
    } as never

    spyOn(Chain, "getExistingTransactionHashes").mockResolvedValue(new Set())
    spyOn(SecretaryManager, "getInstance").mockReturnValue({
        shard: { blockRef: 101 },
        ourValidatorPhase: { currentPhase: 0 },
        setOurValidatorPhase: async () => undefined,
        sendOurValidatorPhaseToSecretary: async () => undefined,
        resolveMergedPeerlist: async () => [],
    } as never)

    const result = await mergeAndOrderMempools([], 101)
    expect(stored.map(tx => tx.hash)).toEqual([oversized.hash, valid.hash])
    expect(sent).toEqual([[valid.hash]])
    expect(result.txs.map(tx => tx.hash)).toEqual([valid.hash])
    expect(log.warning).toHaveBeenCalledWith(
        expect.stringContaining("1 row(s): storage unavailable"),
    )
})
