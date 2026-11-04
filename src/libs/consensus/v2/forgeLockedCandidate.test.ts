import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"

// A committee member can pair a genuine proof of lock with rebuild inputs
// the proof does not cover. Inputs we refuse to sign must only rule out
// that variant, so the honest inputs reported for the same block are still
// tried.

const HEIGHT = 10
const LOCKED_HASH = "locked-hash"
const NOW = 1_800_000_000
const tried: number[] = []
const gathered: { variants: { timestamp: number; peerlist: string[] }[] } = {
    variants: [],
}

const realCandidate = await import("src/libs/consensus/v2/commitLock/candidate")
mock.module("src/libs/consensus/v2/commitLock/candidate", () => ({
    ...realCandidate,
    gatherRetryCandidates: async () => ({
        locked: null,
        committed: [],
        options: [
            {
                origin: "pol",
                hash: LOCKED_HASH,
                round: 1,
                variants: gathered.variants,
                sources: [],
            },
        ],
    }),
    rebuildTransactions: async () => ({ txs: [], failedTxs: [], nonce: {} }),
}))

const { CosignTimestampError, checkCosignTimestamp } = await import(
    "src/libs/consensus/v2/routines/cosignTimestamp"
)
const realCreateBlock = await import("src/libs/consensus/v2/routines/createBlock")
mock.module("src/libs/consensus/v2/routines/createBlock", () => ({
    ...realCreateBlock,
    createBlock: async (
        _txs: unknown,
        _seed: string,
        _previous: string,
        number: number,
        _peerlist: string[],
        timestamp: number,
    ) => {
        tried.push(timestamp)
        // The real order: the timestamp policy runs before the rebuilt
        // hash is compared, so a refused stamp never reaches that check.
        const verdict = checkCosignTimestamp(timestamp, NOW)
        if (!verdict.valid) throw new CosignTimestampError(verdict.reason!)
        return { number, hash: LOCKED_HASH, content: { timestamp } }
    },
}))

mock.module("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({
        commonValidatorSeed: "seed",
        lastBlockNumber: HEIGHT - 1,
    }),
}))

const { default: Chain } = await import("src/libs/blockchain/chain")
const { default: SecretaryManager } = await import(
    "src/libs/consensus/v2/types/secretaryManager"
)
const { getSharedState } = await import("src/utilities/sharedState")
const { forgeLockedCandidate } = await import("src/libs/consensus/v2/PoRBFT")

spyOn(Chain, "getLastBlockHash").mockResolvedValue("hash-9")
spyOn(SecretaryManager, "getInstance").mockReturnValue({
    shard: { blockRef: HEIGHT },
    ourValidatorPhase: { currentPhase: 0 },
} as unknown as InstanceType<typeof SecretaryManager>)
getSharedState.lastBlockNumber = HEIGHT - 1

afterEach(() => {
    tried.length = 0
    gathered.variants = []
})

describe("rebuilding a proof-of-lock block from reported inputs", () => {
    it("skips inputs with a timestamp we will not sign and rebuilds from the honest ones", async () => {
        gathered.variants = [
            { timestamp: NOW + 3600, peerlist: ["a"] },
            { timestamp: NOW - 2, peerlist: ["a"] },
        ]
        const candidate = await forgeLockedCandidate(HEIGHT, true, 2, ["a"])
        expect(tried).toEqual([NOW + 3600, NOW - 2])
        expect(candidate?.block.hash).toBe(LOCKED_HASH)
    })

    it("falls back to a fresh block when every reported timestamp is refused", async () => {
        gathered.variants = [{ timestamp: NOW + 3600, peerlist: ["a"] }]
        const candidate = await forgeLockedCandidate(HEIGHT, true, 2, ["a"])
        expect(tried).toEqual([NOW + 3600])
        expect(candidate).toBeNull()
    })
})
