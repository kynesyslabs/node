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

const VICTIM = "a".repeat(64)
const ATTACKER = "b".repeat(64)
const ESCROW = GCREscrowRoutines.getEscrowAddress("twitter", "@bob")

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

function tx(from: string, edAddress = from, type = "ed25519"): any {
    return {
        content: { from, from_ed25519_address: edAddress },
        signature: { type, data: "" },
    }
}

const deposit = (sender: string) =>
    edit("deposit", { sender, amount: 1000, expiryDays: 30 })

beforeEach(() => {
    mockDb = new FakeGcrDb()
    mockDb.addAccount(VICTIM, 5000n)
    mockDb.addAccount(ATTACKER, 5000n)
})

describe("escrow actor must be the tx signer", () => {
    test("a deposit debiting another account is rejected", async () => {
        const result = await GCREscrowRoutines.apply(
            deposit(VICTIM),
            mockDb.repository(),
            false,
            tx(ATTACKER),
        )

        expect(result.success).toBe(false)
        expect(mockDb.get(VICTIM).balance).toBe(5000n)
        expect(mockDb.get(ESCROW)).toBeUndefined()
    })

    test("a deposit signed by the sender is applied", async () => {
        const result = await GCREscrowRoutines.apply(
            deposit(VICTIM),
            mockDb.repository(),
            false,
            tx(VICTIM),
        )

        expect(result.success).toBe(true)
        expect(mockDb.get(VICTIM).balance).toBe(4000n)
    })

    test("0x prefix and case differences do not break the match", async () => {
        const result = await GCREscrowRoutines.apply(
            deposit(VICTIM),
            mockDb.repository(),
            false,
            tx("0x" + VICTIM.toUpperCase()),
        )

        expect(result.success).toBe(true)
    })

    test("an ed25519 tx is bound to content.from, not from_ed25519_address", async () => {
        const result = await GCREscrowRoutines.apply(
            deposit(VICTIM),
            mockDb.repository(),
            false,
            tx(ATTACKER, VICTIM),
        )

        expect(result.success).toBe(false)
        expect(mockDb.get(VICTIM).balance).toBe(5000n)
    })

    test("a PQC-signed tx is bound to from_ed25519_address", async () => {
        const pqcKey = "c".repeat(64)
        const ok = await GCREscrowRoutines.apply(
            deposit(VICTIM),
            mockDb.repository(),
            false,
            tx(pqcKey, VICTIM, "falcon"),
        )
        expect(ok.success).toBe(true)

        const bad = await GCREscrowRoutines.apply(
            deposit(VICTIM),
            mockDb.repository(),
            false,
            tx(pqcKey, ATTACKER, "falcon"),
        )
        expect(bad.success).toBe(false)
    })

    test("a claim crediting someone other than the signer is rejected", async () => {
        await GCREscrowRoutines.apply(
            deposit(VICTIM),
            mockDb.repository(),
            false,
            tx(VICTIM),
        )

        const result = await GCREscrowRoutines.apply(
            edit("claim", { claimant: ATTACKER }),
            mockDb.repository(),
            false,
            tx(VICTIM),
        )

        expect(result.success).toBe(false)
        expect(mockDb.get(ATTACKER).balance).toBe(5000n)
    })

    test("a refund crediting someone other than the signer is rejected", async () => {
        const result = await GCREscrowRoutines.apply(
            edit("refund", { refunder: VICTIM }),
            mockDb.repository(),
            false,
            tx(ATTACKER),
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/signer/)
    })
})
