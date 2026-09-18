/**
 * What a history row keeps, and what deletes it.
 *
 * Two separate problems met in this table: it stored every transaction's
 * decrypted payload, and nothing but the mempool's five-minute sweep ever
 * removed L2PS data — so the readable copy was the durable one and expiry was
 * an accident of a cleanup job rather than a policy.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const save = jest.fn(async (row: any) => ({ ...row, id: 1 }))
const create = jest.fn((row: any) => row)
const execute = jest.fn(async () => ({ affected: 3 }))
const getMany = jest.fn(async () => [])

const whereClauses: Array<{ clause: string; params: any }> = []

const queryBuilder = {
    where(clause: string, params: any) {
        whereClauses.push({ clause, params })
        return this
    },
    andWhere(clause: string, params: any) {
        whereClauses.push({ clause, params })
        return this
    },
    delete() {
        return this
    },
    from() {
        return this
    },
    orderBy() {
        return this
    },
    take() {
        return this
    },
    skip() {
        return this
    },
    execute,
    getMany,
}

const storePlaintext = { value: false }

jest.mock("src/config", () => ({
    Config: {
        getInstance: () => ({
            l2ps: {
                get historyStorePlaintext() {
                    return storePlaintext.value
                },
            },
        }),
    },
}))

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({
                getRepository: () => ({
                    create,
                    save,
                    createQueryBuilder: () => queryBuilder,
                }),
            }),
        }),
    },
}))

import L2PSTransactionExecutor from "./L2PSTransactionExecutor"

const TX_HASH = "ab".repeat(32)
const TX_CONTENT = {
    type: "native",
    from: "sender",
    to: "recipient",
    amount: 10,
    nonce: 1,
    timestamp: 1_700_000_000_000,
    data: ["native", { message: "lunch money" }],
}
const TX = { hash: TX_HASH, content: TX_CONTENT } as never

const ENVELOPE = { content: { data: ["l2ps", { ciphertext: "…" }] } }

beforeEach(() => {
    save.mockClear()
    create.mockClear()
    execute.mockClear()
    whereClauses.length = 0
    storePlaintext.value = false
    // The executor caches its L1 repository handle across calls.
    ;(L2PSTransactionExecutor as unknown as { l1Repo: unknown }).l1Repo = {}
})

describe("recordTransaction", () => {
    it("keeps the ciphertext and not the message", async () => {
        await L2PSTransactionExecutor.recordTransaction(
            "subnet-1",
            TX,
            "",
            "encrypted-hash",
            0,
            "pending",
            ENVELOPE,
        )

        const row = create.mock.calls[0][0]
        expect(row.encrypted_payload).toEqual(ENVELOPE)
        expect(row.content).toBeNull()
        expect(JSON.stringify(row)).not.toContain("lunch money")
    })

    it("keeps the plaintext too when a node asks for it", async () => {
        storePlaintext.value = true

        await L2PSTransactionExecutor.recordTransaction(
            "subnet-1",
            TX,
            "",
            "encrypted-hash",
            0,
            "pending",
            ENVELOPE,
        )

        expect(create.mock.calls[0][0].content).toEqual(TX_CONTENT)
    })

    it("still records the routing metadata the account query selects on", async () => {
        await L2PSTransactionExecutor.recordTransaction(
            "subnet-1",
            TX,
            "",
            "encrypted-hash",
            0,
            "pending",
            ENVELOPE,
        )

        const row = create.mock.calls[0][0]
        expect(row.from_address).toBe("sender")
        expect(row.to_address).toBe("recipient")
        expect(row.hash).toBe(TX_HASH)
    })
})

describe("pruneHistory", () => {
    it("deletes nothing when no retention is configured", async () => {
        await expect(L2PSTransactionExecutor.pruneHistory(0)).resolves.toBe(0)
        expect(execute).not.toHaveBeenCalled()
    })

    it("deletes nothing for a negative retention", async () => {
        await expect(L2PSTransactionExecutor.pruneHistory(-1)).resolves.toBe(0)
        expect(execute).not.toHaveBeenCalled()
    })

    it("cuts off at the configured age, measured from when the row was written", async () => {
        const before = Date.now()

        await expect(L2PSTransactionExecutor.pruneHistory(30)).resolves.toBe(3)

        const clause = whereClauses.at(-1)
        expect(clause?.clause).toContain("created_at")
        const cutoff = Number(clause?.params.cutoff)
        const thirtyDays = 30 * 24 * 60 * 60 * 1000
        expect(cutoff).toBeGreaterThanOrEqual(before - thirtyDays - 5_000)
        expect(cutoff).toBeLessThanOrEqual(Date.now() - thirtyDays)
    })
})

describe("getSubnetTransactions", () => {
    it("pages a peer forward by record time, not by the sender's clock", async () => {
        // A peer's cursor is the moment its own queue admitted a transaction.
        // Matching that against the wallet-set timestamp would hide any
        // transaction whose payload was stamped before it arrived.
        await L2PSTransactionExecutor.getSubnetTransactions(
            "subnet-1",
            500,
            0,
            1_700_000_000_000,
        )

        const cursor = whereClauses.find(c => c.clause.includes(":since"))
        expect(cursor?.clause).toContain("created_at")
        expect(cursor?.params.since).toEqual(new Date(1_700_000_000_000))
    })
})

describe("getAccountTransactions", () => {
    it("asks only for what is newer than the caller's cursor", async () => {
        await L2PSTransactionExecutor.getAccountTransactions(
            "subnet-1",
            "sender",
            100,
            0,
            1_700_000_000_000,
        )

        const since = whereClauses.find(c => c.clause.includes("tx.timestamp > :since"))
        expect(since?.params.since).toBe("1700000000000")
    })

    it("does not filter by time when no cursor is given", async () => {
        await L2PSTransactionExecutor.getAccountTransactions("subnet-1", "sender")

        expect(whereClauses.some(c => c.clause.includes(":since"))).toBe(false)
    })
})
