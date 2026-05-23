/**
 * P1-T165 — Unit tests for getShard validator-set filter
 *
 * Tests the modified getShard() routine which:
 *   1. Fetches active validators via GCR.getGCRValidatorsAtBlock(lastBlockNumber)
 *   2. If empty AND DEMOS_REQUIRE_VALIDATORS=true → throws
 *   3. If empty otherwise → logs warning + falls back to all online peers
 *   4. If non-empty → filters peers by validator-address-Set membership
 *   5. Then performs Alea-based deterministic random selection
 *
 * All heavy dependencies (PeerManager, GCR, sharedState, logger, Chain)
 * are module-mocked with bun's mock.module() API, installed before the
 * subject is imported.
 *
 * Test isolation: DEMOS_REQUIRE_VALIDATORS is deleted in afterEach to
 * prevent bleed between test cases.
 */

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test"
import type { Validators } from "src/model/entities/Validators"

// ---------------------------------------------------------------------------
// Fake data factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal Peer-shaped object with only the fields getShard reads:
 *   - identity (string)
 *   - status.online (boolean)
 *   - sync.status (boolean)
 *   - sync.block (number)
 *   - connection.string (string)
 */
function makePeer(
    identity: string,
    opts: { online?: boolean; syncStatus?: boolean; syncBlock?: number } = {},
): {
    identity: string
    status: { online: boolean }
    sync: { status: boolean; block: number }
    connection: { string: string }
} {
    return {
        identity,
        status: { online: opts.online ?? true },
        sync: {
            status: opts.syncStatus ?? true,
            block: opts.syncBlock ?? 100,
        },
        connection: { string: `http://peer-${identity}.example.com` },
    }
}

/**
 * Build a minimal Validators-shaped object with just the fields
 * getShard reads: address, status, valid_at.
 * All other columns are nullable so we omit them.
 */
function makeValidator(
    address: string | null,
    opts: { status?: string; valid_at?: number } = {},
): Partial<Validators> {
    return {
        address,
        status: opts.status ?? "2",
        valid_at: opts.valid_at ?? 50,
        // nullable columns — not read by getShard
        connection_url: null,
        staked_amount: null,
        first_seen: null,
        unstake_requested_at: null,
        unstake_available_at: null,
    }
}

// ---------------------------------------------------------------------------
// Mutable mock state — mutated per test before the module is re-used.
// ---------------------------------------------------------------------------

const mockState = {
    onlinePeers: [] as ReturnType<typeof makePeer>[],
    validators: [] as Partial<Validators>[],
    lastBlockNumber: 100,
    shardSize: 10,
    warningMessages: [] as string[],
    infoMessages: [] as string[],
    debugMessages: [] as string[],
}

// ---------------------------------------------------------------------------
// Module mocks — must be installed before importing the subject.
// ---------------------------------------------------------------------------

// Mock PeerManager so getOnlinePeers() returns our controlled list.
mock.module("src/libs/peer", () => ({
    PeerManager: {
        getInstance: () => ({
            getOnlinePeers: async () => mockState.onlinePeers,
        }),
    },
    // Peer class is only used as a type in getShard.ts; no instantiation needed.
    Peer: class FakePeer {},
    __esModule: true,
}))

// Mock GCR — only getGCRValidatorsAtBlock is called.
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    default: {
        getGCRValidatorsAtBlock: async (_blockNum: number) =>
            mockState.validators,
    },
    __esModule: true,
}))

// Mock sharedState — getShard reads lastBlockNumber and shardSize.
mock.module("src/utilities/sharedState", () => ({
    getSharedState: new Proxy(
        {},
        {
            get(_target, prop) {
                if (prop === "lastBlockNumber")
                    return mockState.lastBlockNumber
                if (prop === "shardSize") return mockState.shardSize
                // Any other property accessed (publicKeyHex, etc.) returns undefined.
                return undefined
            },
        },
    ),
    __esModule: true,
}))

// Mock Chain — imported by getShard.ts but not called in the path under test.
mock.module("src/libs/blockchain/chain", () => ({
    default: {},
    __esModule: true,
}))

// Mock logger — spy on warning/info/debug/custom calls to assert messages.
mock.module("src/utilities/logger", () => ({
    default: {
        warning: (msg: string) => {
            mockState.warningMessages.push(msg)
        },
        info: (msg: string) => {
            mockState.infoMessages.push(msg)
        },
        debug: (msg: string) => {
            mockState.debugMessages.push(msg)
        },
        custom: () => {},
    },
    __esModule: true,
}))

// ---------------------------------------------------------------------------
// Import subject AFTER all mocks.
// ---------------------------------------------------------------------------

let getShard: (seed: string) => Promise<{ identity: string }[]>
let resetValidatorCache: () => void

beforeAll(async () => {
    const mod = await import(
        "src/libs/consensus/v2/routines/getShard"
    )
    getShard = mod.default as (seed: string) => Promise<{ identity: string }[]>
    resetValidatorCache = mod.__resetValidatorCache as () => void
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMockState() {
    mockState.onlinePeers = []
    mockState.validators = []
    mockState.lastBlockNumber = 100
    mockState.shardSize = 10
    mockState.warningMessages = []
    mockState.infoMessages = []
    mockState.debugMessages = []
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
    // Prevent DEMOS_REQUIRE_VALIDATORS from bleeding between tests.
    delete process.env.DEMOS_REQUIRE_VALIDATORS
    resetMockState()
    // Per-block validator cache otherwise persists across tests; flush it
    // so each case re-issues the mocked DB query.
    resetValidatorCache()
})

describe("getShard — validator-set filter", () => {
    // -----------------------------------------------------------------------
    // Case (a): 3 online peers (all validators), 3 validators (all match)
    //           → shard contains all 3 peers, every member is a validator.
    // -----------------------------------------------------------------------
    it("(a) 3 online peers all match active validators — shard contains all 3", async () => {
        const peers = [
            makePeer("0xAAA"),
            makePeer("0xBBB"),
            makePeer("0xCCC"),
        ]
        const validators = [
            makeValidator("0xAAA"),
            makeValidator("0xBBB"),
            makeValidator("0xCCC"),
        ]

        mockState.onlinePeers = peers
        mockState.validators = validators
        mockState.shardSize = 10 // larger than peer count, so all are selected

        const shard = await getShard("seed-a")

        expect(shard).toHaveLength(3)

        const identities = shard.map(p => p.identity)
        expect(identities).toContain("0xAAA")
        expect(identities).toContain("0xBBB")
        expect(identities).toContain("0xCCC")

        // No fallback warning should have been emitted.
        expect(
            mockState.warningMessages.some(m =>
                m.includes("no active validators"),
            ),
        ).toBe(false)
    })

    // -----------------------------------------------------------------------
    // Case (b): 2 online peers — 1 validator + 1 non-validator
    //           → shard contains only the validator peer.
    // -----------------------------------------------------------------------
    it("(b) 1 validator peer + 1 non-validator peer — only validator in shard", async () => {
        const validatorPeer = makePeer("0xVALIDATOR")
        const outsiderPeer = makePeer("0xOUTSIDER")

        mockState.onlinePeers = [validatorPeer, outsiderPeer]
        mockState.validators = [makeValidator("0xVALIDATOR")]

        const shard = await getShard("seed-b")

        expect(shard).toHaveLength(1)
        expect(shard[0].identity).toBe("0xVALIDATOR")

        const identities = shard.map(p => p.identity)
        expect(identities).not.toContain("0xOUTSIDER")
    })

    // -----------------------------------------------------------------------
    // Case (c): empty validators table, DEMOS_REQUIRE_VALIDATORS unset
    //           → warning logged, shard falls back to all online peers.
    // -----------------------------------------------------------------------
    it("(c) empty validators table without DEMOS_REQUIRE_VALIDATORS — fallback to all online peers", async () => {
        delete process.env.DEMOS_REQUIRE_VALIDATORS

        const peers = [makePeer("0xP1"), makePeer("0xP2")]
        mockState.onlinePeers = peers
        mockState.validators = []

        const shard = await getShard("seed-c")

        // Falls back to online peers — both returned.
        expect(shard).toHaveLength(2)
        const identities = shard.map(p => p.identity)
        expect(identities).toContain("0xP1")
        expect(identities).toContain("0xP2")

        // Warning mentioning "no active validators" must have been logged.
        expect(
            mockState.warningMessages.some(m =>
                m.includes("no active validators"),
            ),
        ).toBe(true)
    })

    // -----------------------------------------------------------------------
    // Case (d): empty validators + DEMOS_REQUIRE_VALIDATORS=true
    //           → throws Error containing "refusing to operate".
    // -----------------------------------------------------------------------
    it("(d) empty validators with DEMOS_REQUIRE_VALIDATORS=true — throws 'refusing to operate'", async () => {
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"

        mockState.onlinePeers = [makePeer("0xANY")]
        mockState.validators = []

        await expect(getShard("seed-d")).rejects.toThrow(/refusing to operate/)
    })

    // -----------------------------------------------------------------------
    // Case (e): validators table has rows but all status≠"2" (e.g. UNSTAKING="3"
    //           or EXITED="0"). getGCRValidatorsAtBlock already filters status
    //           in production. Here we simulate the returned-empty result by
    //           returning an empty array (which is what getGCRValidatorsAtBlock
    //           produces when no row has status="2"). Verifies fallback path.
    // -----------------------------------------------------------------------
    it("(e) getGCRValidatorsAtBlock returns empty (all non-active statuses) — fallback path", async () => {
        delete process.env.DEMOS_REQUIRE_VALIDATORS

        // Simulate: the DB had rows with status "3" and "0" but the query
        // filtered them to zero results (as the real implementation does).
        mockState.validators = []

        const peers = [makePeer("0xSTAKER")]
        mockState.onlinePeers = peers

        const shard = await getShard("seed-e")

        // Fallback: all online peers included.
        expect(shard).toHaveLength(1)
        expect(shard[0].identity).toBe("0xSTAKER")

        // Warning must be logged.
        expect(
            mockState.warningMessages.some(m =>
                m.includes("no active validators"),
            ),
        ).toBe(true)
    })

    // -----------------------------------------------------------------------
    // Case (f): validator with valid_at > currentBlock is excluded by
    //           getGCRValidatorsAtBlock (which applies LessThanOrEqual filter).
    //           We return it as already excluded from the mock to confirm the
    //           new validator stays out of the shard until valid_at is reached.
    // -----------------------------------------------------------------------
    it("(f) new validator (valid_at > currentBlock) excluded — not in shard", async () => {
        // currentBlock = 100 (mockState.lastBlockNumber default)
        // pendingValidator has valid_at=200, so it's not yet active.
        // The real getGCRValidatorsAtBlock filters `valid_at <= blockNumber`,
        // so it would not return this row. We replicate by omitting it.
        const confirmedValidator = makeValidator("0xCONFIRMED", {
            valid_at: 50,
        })
        // Pending validator is NOT returned — mock simulates the DB filter.

        const confirmedPeer = makePeer("0xCONFIRMED")
        const pendingPeer = makePeer("0xPENDING")

        mockState.onlinePeers = [confirmedPeer, pendingPeer]
        // Only confirmed validator is in the returned set.
        mockState.validators = [confirmedValidator]

        const shard = await getShard("seed-f")

        expect(shard).toHaveLength(1)
        expect(shard[0].identity).toBe("0xCONFIRMED")

        const identities = shard.map(p => p.identity)
        expect(identities).not.toContain("0xPENDING")
    })

    // -----------------------------------------------------------------------
    // Case (g): online peer count > shardSize, filter retains validator-subset,
    //           Alea selects deterministically — output stable across runs with
    //           same seed.
    // -----------------------------------------------------------------------
    it("(g) large validator pool + shardSize limit — deterministic output across same seed", async () => {
        const validatorCount = 8
        const peers = Array.from({ length: validatorCount }, (_, i) =>
            makePeer(`0x${String(i).padStart(3, "0")}`),
        )
        const validators = peers.map(p => makeValidator(p.identity))

        mockState.onlinePeers = peers
        mockState.validators = validators
        mockState.shardSize = 3 // deliberately smaller than peer count

        const seed = "deterministic-seed-g"
        const shard1 = await getShard(seed)

        // Reset logged messages but keep peer/validator state identical.
        mockState.warningMessages = []
        mockState.infoMessages = []
        mockState.debugMessages = []

        const shard2 = await getShard(seed)

        // Both shards must be exactly shardSize.
        expect(shard1).toHaveLength(3)
        expect(shard2).toHaveLength(3)

        // Order and members must be bit-identical across runs.
        const ids1 = shard1.map(p => p.identity)
        const ids2 = shard2.map(p => p.identity)
        expect(ids1).toEqual(ids2)

        // All shard members must be validators.
        const validatorSet = new Set(validators.map(v => v.address))
        for (const p of shard1) {
            expect(validatorSet.has(p.identity)).toBe(true)
        }
    })

    // -----------------------------------------------------------------------
    // Case (h): Validators.address is NULL for some rows.
    //           NULL must be filtered out of the Set and must NOT cause any
    //           peer with identity string "null" to enter the shard.
    // -----------------------------------------------------------------------
    it("(h) validator row with NULL address — NULL filtered out, no false-positive peer match", async () => {
        // One legitimate validator, one row with address=null.
        const legit = makeValidator("0xLEGIT")
        const nullRow = makeValidator(null) // address is null

        // A peer whose identity happens to be the string "null" — must not match.
        const nullStringPeer = makePeer("null")
        const legitPeer = makePeer("0xLEGIT")
        const outsider = makePeer("0xOUTSIDER")

        mockState.onlinePeers = [nullStringPeer, legitPeer, outsider]
        mockState.validators = [legit, nullRow]

        const shard = await getShard("seed-h")

        // Only the legitimately-matching peer should be present.
        const identities = shard.map(p => p.identity)
        expect(identities).toContain("0xLEGIT")
        expect(identities).not.toContain("null")
        expect(identities).not.toContain("0xOUTSIDER")
    })

    // -----------------------------------------------------------------------
    // Case (i): Per-block validator cache.
    //           Two consecutive getShard calls at the same lastBlockNumber
    //           must hit the mocked DB only once; bumping the block
    //           re-issues the query.
    // -----------------------------------------------------------------------
    it("(i) validator set is cached per-block — DB hit once per block height", async () => {
        const peer = makePeer("0xCACHE")
        mockState.onlinePeers = [peer]
        mockState.validators = [makeValidator("0xCACHE")]

        let callCount = 0
        const originalGetter = mockState.validators
        // Spy on the underlying lookup by counting accesses through the
        // mocked GCR module. The mock returns mockState.validators by
        // reference, so we wrap with a Proxy that increments callCount.
        Object.defineProperty(mockState, "validators", {
            configurable: true,
            get() {
                callCount += 1
                return originalGetter
            },
        })

        await getShard("seed-i-1")
        await getShard("seed-i-2")
        expect(callCount).toBe(1)

        // Bump the block — cache must invalidate.
        mockState.lastBlockNumber += 1
        await getShard("seed-i-3")
        expect(callCount).toBe(2)

        // Restore plain property so afterEach reset works.
        Object.defineProperty(mockState, "validators", {
            configurable: true,
            writable: true,
            value: originalGetter,
        })
    })
})
