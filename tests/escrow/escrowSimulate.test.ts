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

const SENDER = "a".repeat(64)
const ESCROW = GCREscrowRoutines.getEscrowAddress("twitter", "@bob")

function depositEdit(): any {
    return {
        type: "escrow",
        operation: "deposit",
        account: ESCROW,
        data: {
            sender: SENDER,
            platform: "twitter",
            username: "@bob",
            amount: 1000,
            expiryDays: 30,
        },
        txhash: "",
        isRollback: false,
    }
}

beforeEach(() => {
    mockDb = new FakeGcrDb()
    mockDb.addAccount(SENDER, 5000n)
})

describe("escrow deposit simulate mode", () => {
    test("a simulated deposit to a new escrow address writes nothing", async () => {
        const result = await GCREscrowRoutines.applyEscrowDeposit(
            depositEdit(),
            mockDb.repository(),
            true,
        )

        expect(result.success).toBe(true)
        expect(mockDb.get(ESCROW)).toBeUndefined()
        expect(mockDb.saved).toEqual([])
        expect(mockDb.get(SENDER).balance).toBe(5000n)
    })

    test("a real deposit creates the escrow account inside the transaction", async () => {
        const result = await GCREscrowRoutines.applyEscrowDeposit(
            depositEdit(),
            mockDb.repository(),
            false,
        )

        expect(result.success).toBe(true)
        expect(mockDb.get(ESCROW).escrows[ESCROW].balance).toBe("1000")
        expect(mockDb.get(SENDER).balance).toBe(4000n)
    })
})
