import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

// The draw is replaced by a one-member pool so that every synced block counts
// as a selection; what is under test is what the setting does with a miss.
const realGetShard = await import("src/libs/consensus/v2/routines/getShard")
const OUR_KEY = "0x" + "ab".repeat(32)

mock.module("src/libs/consensus/v2/routines/getShard", () => ({
    ...realGetShard,
    getEligiblePool: async () => [OUR_KEY],
    pinShardIdentities: () => undefined,
}))
mock.module("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    default: async () => ({ commonValidatorSeed: "seed" }),
}))

const { recordSyncedBlock } = await import(
    "src/libs/consensus/v2/routines/stallDetection"
)
const { Config } = await import("src/config")
const { getSharedState } = await import("src/utilities/sharedState")
const { default: Chain } = await import("src/libs/blockchain/chain")
const { default: log } = await import("src/utilities/logger")
const { getMetricsService } = await import("src/features/metrics/MetricsService")

// Pinned for the life of this test process.
getSharedState.setShardSizeFromGenesis(10)

const savedKeypair = getSharedState.keypair
const savedFastSyncCount = getSharedState.fastSyncCount
let counted: string[]
let errors: string[]
let restore: Array<() => void>

function useThreshold(stallDetectionBlocks: number) {
    const spy = spyOn(Config, "getInstance").mockReturnValue({
        core: { stallDetectionBlocks },
    } as never)
    restore.push(() => spy.mockRestore())
}

function missedBlock(number: number) {
    return {
        number,
        validation_data: { signatures: {} },
        content: {
            timestamp: Math.floor(Date.now() / 1000),
            peerlist: [OUR_KEY],
        },
    } as never
}

beforeEach(() => {
    counted = []
    errors = []
    restore = []
    const counter = spyOn(getMetricsService(), "incrementCounter").mockImplementation(
        ((name: string) => {
            counted.push(name)
        }) as never,
    )
    const chain = spyOn(Chain, "getBlockByNumber").mockResolvedValue({
        number: 0,
    } as never)
    const logError = spyOn(log, "error").mockImplementation(((msg: string) => {
        errors.push(String(msg))
    }) as never)
    restore.push(
        () => counter.mockRestore(),
        () => chain.mockRestore(),
        () => logError.mockRestore(),
    )
    getSharedState.keypair = {
        publicKey: Uint8Array.from(Buffer.from(OUR_KEY.slice(2), "hex")),
        privateKey: new Uint8Array(64),
    }
    getSharedState.fastSyncCount = 1
    getSharedState.consecutiveMissedShardBlocks = 0
})

afterEach(() => {
    restore.forEach(fn => fn())
    getSharedState.keypair = savedKeypair
    getSharedState.fastSyncCount = savedFastSyncCount
    getSharedState.consecutiveMissedShardBlocks = 0
})

describe("a shard selection whose signature is missing", () => {
    it("is counted and reported with the stall response on", async () => {
        useThreshold(3)
        await recordSyncedBlock(missedBlock(10))
        expect(counted).toEqual(["consensus_missed_signatures_total"])
        expect(errors.some(l => l.includes("(1/3)"))).toBe(true)
        expect(errors.some(l => l.includes("appears stalled"))).toBe(false)
    })

    it("declares the node stalled once the threshold is reached", async () => {
        useThreshold(2)
        await recordSyncedBlock(missedBlock(10))
        await recordSyncedBlock(missedBlock(11))
        expect(counted).toHaveLength(2)
        expect(errors.some(l => l.includes("appears stalled"))).toBe(true)
    })

    it("is still counted and reported when the stall response is switched off", async () => {
        useThreshold(0)
        for (let n = 10; n < 15; n++) {
            await recordSyncedBlock(missedBlock(n))
        }
        expect(counted).toHaveLength(5)
        expect(errors.filter(l => l.includes("signature is missing"))).toHaveLength(5)
        expect(errors.some(l => l.includes("appears stalled"))).toBe(false)
    })

    it("is not counted when our signature is on the block", async () => {
        useThreshold(0)
        const block = missedBlock(10) as { validation_data: { signatures: Record<string, string> } }
        block.validation_data.signatures[OUR_KEY] = "sig"
        await recordSyncedBlock(block as never)
        expect(counted).toEqual([])
    })
})
