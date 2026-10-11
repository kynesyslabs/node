import { FakeGcrDb, fakeCreateAccount } from "../utils/escrowHarness"

let mockDb: FakeGcrDb
jest.mock("src/libs/blockchain/gcr/handleGCR", () => ({
    __esModule: true,
    default: {
        createAccount: (...args: any[]) =>
            fakeCreateAccount(() => mockDb)(...(args as [string])),
    },
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/identityManager", () => ({
    __esModule: true,
    default: {
        getWeb2Identities: jest.fn(async () => [{ username: "@bob" }]),
    },
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("src/utilities/logger", () =>
    jest.requireActual("../utils/escrowHarness").mockLogger(),
)

import GCREscrowRoutines from "src/libs/blockchain/gcr/gcr_routines/GCREscrowRoutines"

const ALICE = "a".repeat(64)
const BOB = "b".repeat(64)
const CAROL = "c".repeat(64)
const ESCROW = GCREscrowRoutines.getEscrowAddress("twitter", "@bob")
const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

function edit(operation: string, data: Record<string, any>): any {
    return {
        type: "escrow",
        operation,
        account: ESCROW,
        data: { platform: "twitter", username: "@bob", ...data },
        txhash: "",
        isRollback: false,
    }
}
const signedBy = (from: string): any => ({
    content: { from, from_ed25519_address: from },
    signature: { type: "ed25519", data: "" },
})
const apply = (e: any, signer: string) =>
    GCREscrowRoutines.apply(e, mockDb.repository(), false, signedBy(signer))
const deposit = (sender: string, expiryDays = 1) =>
    apply(edit("deposit", { sender, amount: 1000, expiryDays }), sender)
const at = (t: number) => jest.spyOn(Date, "now").mockReturnValue(t)
const escrow = () => mockDb.get(ESCROW).escrows[ESCROW]

beforeEach(() => {
    mockDb = new FakeGcrDb()
    mockDb.addAccount(ALICE, 10_000n)
    mockDb.addAccount(BOB, 0n)
    mockDb.addAccount(CAROL, 10_000n)
})

afterEach(() => jest.restoreAllMocks())

describe("escrow address reuse", () => {
    test("a handle can receive a new escrow after its escrow was claimed", async () => {
        at(T0)
        expect((await deposit(ALICE)).success).toBe(true)
        expect((await apply(edit("claim", { claimant: BOB }), BOB)).success).toBe(true)

        at(T0 + 1000)
        const result = await deposit(CAROL, 30)

        expect(result.success).toBe(true)
        expect(escrow().claimed).toBeFalsy()
        expect(escrow().balance).toBe("1000")
        expect(escrow().deposits.map((d: any) => d.from)).toEqual([CAROL])
        expect(escrow().expiryTimestamp).toBe(T0 + 1000 + 30 * DAY)
    })

    test("a handle can receive a new escrow after an expired escrow was fully refunded", async () => {
        at(T0)
        await deposit(ALICE)
        at(T0 + 2 * DAY)
        expect((await apply(edit("refund", { refunder: ALICE }), ALICE)).success).toBe(true)

        const result = await deposit(CAROL, 30)

        expect(result.success).toBe(true)
        expect(escrow().deposits.map((d: any) => d.from)).toEqual([CAROL])
        expect(escrow().expiryTimestamp).toBe(T0 + 2 * DAY + 30 * DAY)
    })

    test("an expired escrow that still holds unrefunded funds keeps rejecting deposits", async () => {
        at(T0)
        await deposit(ALICE)
        at(T0 + 2 * DAY)

        await expect(deposit(CAROL, 30)).rejects.toThrow(/expired/)
        expect(escrow().deposits.map((d: any) => d.from)).toEqual([ALICE])
    })
})
