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
    default: {},
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
const CAROL = "c".repeat(64)
const ESCROW = GCREscrowRoutines.getEscrowAddress("twitter", "@bob")
const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

function edit(
    operation: string,
    data: Record<string, any>,
    isRollback = false,
): any {
    return {
        type: "escrow",
        operation,
        account: ESCROW,
        data: { platform: "twitter", username: "@bob", ...data },
        txhash: "",
        isRollback,
    }
}
const signedBy = (from: string): any => ({
    content: { from, from_ed25519_address: from },
    signature: { type: "ed25519", data: "" },
})
const apply = (e: any, signer: string) =>
    GCREscrowRoutines.apply(e, mockDb.repository(), false, signedBy(signer))
const escrow = () => mockDb.get(ESCROW).escrows[ESCROW]

beforeEach(async () => {
    mockDb = new FakeGcrDb()
    mockDb.addAccount(ALICE, 10_000n)
    mockDb.addAccount(CAROL, 10_000n)
    jest.spyOn(Date, "now").mockReturnValue(T0)
    expect(
        (
            await apply(
                edit("deposit", { sender: ALICE, amount: 1000, expiryDays: 1 }),
                ALICE,
            )
        ).success,
    ).toBe(true)
    expect(
        (await apply(edit("deposit", { sender: CAROL, amount: 500 }), CAROL))
            .success,
    ).toBe(true)
    jest.spyOn(Date, "now").mockReturnValue(T0 + 2 * DAY)
})

afterEach(() => jest.restoreAllMocks())

describe("escrow refund rollback", () => {
    test("rolling back a refund restores deposits and balances", async () => {
        const refund = edit("refund", { refunder: ALICE })
        expect((await apply(refund, ALICE)).success).toBe(true)
        expect(mockDb.get(ALICE).balance).toBe(10_000n)
        expect(escrow().balance).toBe("500")

        const rollback = await apply({ ...refund, isRollback: true }, ALICE)

        expect(rollback.success).toBe(true)
        expect(mockDb.get(ALICE).balance).toBe(9_000n)
        expect(escrow().balance).toBe("1500")
        expect(escrow().deposits.filter((d: any) => d.refunded)).toEqual([])
        expect(escrow().deposits.map((d: any) => d.from)).toEqual([
            ALICE,
            CAROL,
        ])
    })

    test("after a rollback the depositor can take the refund again", async () => {
        const refund = edit("refund", { refunder: ALICE })
        await apply(refund, ALICE)
        await apply({ ...refund, isRollback: true }, ALICE)

        expect((await apply(refund, ALICE)).success).toBe(true)
        expect(mockDb.get(ALICE).balance).toBe(10_000n)
    })

    test("rolling back the last refund restores an otherwise empty escrow", async () => {
        await apply(edit("refund", { refunder: ALICE }), ALICE)
        const carolRefund = edit("refund", { refunder: CAROL })
        await apply(carolRefund, CAROL)
        expect(escrow().balance).toBe("0")

        const rollback = await apply(
            { ...carolRefund, isRollback: true },
            CAROL,
        )

        expect(rollback.success).toBe(true)
        expect(escrow().balance).toBe("500")
        expect(mockDb.get(CAROL).balance).toBe(9_500n)
    })

    test("a refund cannot be taken twice", async () => {
        const refund = edit("refund", { refunder: ALICE })
        await apply(refund, ALICE)

        await expect(apply(refund, ALICE)).rejects.toThrow()
        expect(mockDb.get(ALICE).balance).toBe(10_000n)
    })
})
