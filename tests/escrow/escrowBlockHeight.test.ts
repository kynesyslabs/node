import { FakeGcrDb } from "../utils/escrowHarness"

// Drives HandleGCR.applyToTx, the call consensus rollback and
// Sync.syncGCRTables make, with the real escrow routine on an in-memory DB.
let mockDb: FakeGcrDb
jest.mock("src/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({
                getRepository: () => mockDb.repository(),
            }),
        }),
    },
}))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { checkTxExists: async () => false },
}))
jest.mock("src/libs/network/server_rpc", () => ({
    __esModule: true,
    emptyResponse: {},
}))
jest.mock("src/features/incentive/referrals", () => ({
    __esModule: true,
    Referrals: { generateReferralCode: () => "code" },
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/identityManager", () => ({
    __esModule: true,
    default: { getWeb2Identities: async () => [{ username: "@bob" }] },
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/assignXM", () => ({
    __esModule: true,
    assignXM: jest.fn(),
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/assignWeb2", () => ({
    __esModule: true,
    assignWeb2: jest.fn(),
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/manageNative", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/gcrStateSaverHelper", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/hashGCR", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/GCRNonceRoutines", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("src/utilities/logger", () =>
    jest.requireActual("../utils/escrowHarness").mockLogger(),
)

import HandleGCR from "src/libs/blockchain/gcr/handleGCR"
import GCREscrowRoutines from "src/libs/blockchain/gcr/gcr_routines/GCREscrowRoutines"

const ALICE = "a".repeat(64)
const BOB = "b".repeat(64)
const ESCROW = GCREscrowRoutines.getEscrowAddress("twitter", "@bob")
const BLOCKS_PER_DAY = 8640
const DAY_MS = 24 * 60 * 60 * 1000
const H0 = 1_000
const EXPIRY = H0 + BLOCKS_PER_DAY // expiryDays = 1
const T0 = 1_700_000_000_000
const TX_TIMESTAMP = T0 - 5_000

function tx(signer: string, edits: any[]): any {
    return {
        hash: `${signer}:${JSON.stringify(edits)}`,
        content: {
            from: signer,
            from_ed25519_address: signer,
            timestamp: TX_TIMESTAMP,
            gcr_edits: edits,
        },
        signature: { type: "ed25519", data: "" },
    }
}
function escrowEdit(operation: string, data: Record<string, any>): any {
    return {
        type: "escrow",
        operation,
        account: ESCROW,
        data: { platform: "twitter", username: "@bob", ...data },
        txhash: "",
        isRollback: false,
    }
}
// Fresh objects per call so no test shares edit objects with another
const depositTx = () =>
    tx(ALICE, [
        escrowEdit("deposit", { sender: ALICE, amount: 1000, expiryDays: 1 }),
    ])
const claimTx = () => tx(BOB, [escrowEdit("claim", { claimant: BOB })])
const refundTx = () => tx(ALICE, [escrowEdit("refund", { refunder: ALICE })])

const applyAt = (t: any, height: number, isRollback = false) =>
    HandleGCR.applyToTx(t, isRollback, false, height)
const wallClock = (t: number) => jest.spyOn(Date, "now").mockReturnValue(t)
const escrow = () => mockDb.get(ESCROW).escrows[ESCROW]
// Balances and escrow data per account. HandleGCR.createAccount also stamps
// account metadata (createdAt, updatedAt, points.lastUpdated) with new Date();
// that is shared account-creation code, not escrow state, so it is left out.
const escrowState = () =>
    [...mockDb.rows.values()].map(({ pubkey, balance, escrows }) => ({
        pubkey,
        balance,
        escrows,
    }))

function freshNode(): FakeGcrDb {
    const db = new FakeGcrDb()
    db.addAccount(ALICE, 10_000n)
    db.addAccount(BOB, 0n)
    return db
}

beforeEach(() => {
    mockDb = freshNode()
    wallClock(T0)
})

afterEach(() => jest.restoreAllMocks())

describe("escrow expiry is decided by block height", () => {
    test("the same edits at the same heights give the same state whatever Date.now says", async () => {
        const run = async (now: number) => {
            mockDb = freshNode()
            wallClock(now)
            const results = [
                await applyAt(depositTx(), H0),
                await applyAt(claimTx(), H0 + 10),
            ]
            return { results, rows: escrowState() }
        }

        const early = await run(T0)
        const late = await run(T0 + 400 * DAY_MS)

        expect(early.results.every(r => r.success)).toBe(true)
        expect(late).toEqual(early)
        const stored = late.rows.find(r => r.pubkey === ESCROW).escrows[ESCROW]
        expect(stored).toMatchObject({
            expiryBlock: EXPIRY,
            createdBlock: H0,
            claimedBlock: H0 + 10,
        })
        expect(stored.deposits[0]).toMatchObject({
            block: H0,
            timestamp: TX_TIMESTAMP,
        })
    })

    test("a claim is accepted in the last block before expiryBlock", async () => {
        await applyAt(depositTx(), H0)

        const result = await applyAt(claimTx(), EXPIRY - 1)

        expect(result.success).toBe(true)
        expect(mockDb.get(BOB).balance).toBe(1000n)
    })

    test("a claim is rejected at expiryBlock even if wall-clock time has not advanced", async () => {
        await applyAt(depositTx(), H0)

        const result = await applyAt(claimTx(), EXPIRY)

        expect(result.success).toBe(false)
        expect(mockDb.get(BOB).balance).toBe(0n)
        expect(escrow().claimed).toBeFalsy()
    })

    test("a refund is rejected before expiryBlock even if wall-clock time is past expiry", async () => {
        await applyAt(depositTx(), H0)
        wallClock(T0 + 2 * DAY_MS)

        const result = await applyAt(refundTx(), EXPIRY - 1)

        expect(result.success).toBe(false)
        expect(mockDb.get(ALICE).balance).toBe(9_000n)
    })

    test("a refund is accepted at expiryBlock", async () => {
        await applyAt(depositTx(), H0)

        const result = await applyAt(refundTx(), EXPIRY)

        expect(result.success).toBe(true)
        expect(mockDb.get(ALICE).balance).toBe(10_000n)
    })

    test("a syncing node replaying blocks long after they were made accepts a claim that was valid then", async () => {
        // The producing node applies the deposit and the claim close in time
        await applyAt(depositTx(), H0)
        wallClock(T0 + 60_000)
        expect((await applyAt(claimTx(), H0 + 100)).success).toBe(true)
        const producerState = escrowState()

        // A node syncing a year later replays the same txs at their block numbers
        mockDb = freshNode()
        wallClock(T0 + 365 * DAY_MS)
        expect((await applyAt(depositTx(), H0)).success).toBe(true)
        const replay = await applyAt(claimTx(), H0 + 100)

        expect(replay.success).toBe(true)
        expect(escrowState()).toEqual(producerState)
    })

    test("an escrow edit without a block height fails visibly and changes nothing", async () => {
        const result = await HandleGCR.applyToTx(
            depositTx(),
            false,
            false,
            undefined as unknown as number,
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/block height/)
        expect(mockDb.get(ESCROW)).toBeUndefined()
        expect(mockDb.get(ALICE).balance).toBe(10_000n)
    })
})

describe("rollback with the apply height", () => {
    test("rolling back a block's claim and deposit restores the original state", async () => {
        const before = [...mockDb.rows.entries()]
        await applyAt(depositTx(), H0)
        await applyAt(claimTx(), H0)

        expect((await applyAt(claimTx(), H0, true)).success).toBe(true)
        expect(mockDb.get(BOB).balance).toBe(0n)
        expect(escrow()).toMatchObject({ claimed: false, balance: "1000" })
        expect(escrow().claimedBlock).toBeUndefined()

        expect((await applyAt(depositTx(), H0, true)).success).toBe(true)
        expect(mockDb.get(ALICE).balance).toBe(10_000n)
        expect(escrow().deposits).toEqual([])
        expect(mockDb.get(ALICE)).toEqual(new Map(before).get(ALICE))
    })

    test("HandleGCR.rollback undoes applied escrow edits at the given height", async () => {
        const t = depositTx()
        await applyAt(t, H0)

        const result = await HandleGCR.rollback(t, [...t.content.gcr_edits], H0)

        expect(result.success).toBe(true)
        expect(mockDb.get(ALICE).balance).toBe(10_000n)
        expect(escrow().deposits).toEqual([])
    })
})

describe("the rollback flag comes from the caller, not the tx", () => {
    test("a signed edit claiming isRollback is applied forward", async () => {
        expect((await applyAt(depositTx(), H0)).success).toBe(true)
        expect(mockDb.get(ALICE).balance).toBe(9_000n)

        // Before expiry, a depositor marks a deposit edit as a rollback to pull funds out early
        const forged = depositTx()
        forged.content.gcr_edits[0].isRollback = true
        await applyAt(forged, H0 + 1)

        expect(mockDb.get(ALICE).balance).toBe(8_000n)
        expect(escrow()).toMatchObject({ balance: "2000" })
    })

    test("rolling back leaves the tx's own edits unflagged", async () => {
        const t = depositTx()
        await applyAt(t, H0)
        await HandleGCR.rollback(t, [...t.content.gcr_edits], H0)

        expect(t.content.gcr_edits[0].isRollback).toBe(false)
    })
})
