/**
 * A confirmed L2PS transfer could be paid out twice.
 *
 * Admission asked the L2PS mempool whether it had seen the payload, and those
 * rows are deleted by age (`l2ps.cleanupAgeMs`, five minutes by default).
 * Nothing else stopped a second run: the inner nonce is not enforced, the
 * ciphertext is readable from the subnet's history, and the execute RPC takes
 * no outer signature or fee. The permanent record of what executed lives in
 * `l2ps_transactions`, but it was only touched after the balance edits had
 * already been generated.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const findOne = jest.fn()
const getRepository = jest.fn(() => ({ findOne }))

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
            getDataSource: () => ({ getRepository }),
        }),
    },
}))

import L2PSTransactionExecutor from "./L2PSTransactionExecutor"

const ORIGINAL_HASH = "ab".repeat(32)

beforeEach(() => {
    findOne.mockReset()
    getRepository.mockClear()
    // The executor caches its L1 repository handle across calls.
    ;(L2PSTransactionExecutor as unknown as { l1Repo: unknown }).l1Repo = {}
})

describe("L2PSTransactionExecutor.hasExecuted", () => {
    it("reports a transfer that already executed, whatever the mempool says", async () => {
        findOne.mockResolvedValue({ id: 7 })

        await expect(
            L2PSTransactionExecutor.hasExecuted(ORIGINAL_HASH),
        ).resolves.toBe(true)
        expect(findOne).toHaveBeenCalledWith(
            expect.objectContaining({ where: { hash: ORIGINAL_HASH } }),
        )
    })

    it("lets a transfer through the first time", async () => {
        findOne.mockResolvedValue(null)

        await expect(
            L2PSTransactionExecutor.hasExecuted(ORIGINAL_HASH),
        ).resolves.toBe(false)
    })

    it("answers by the original hash, so re-encrypting the same transfer does not help", async () => {
        // The payload is re-wrapped, giving it a fresh encrypted hash, but the
        // transfer inside is the one that already ran.
        findOne.mockImplementation(async ({ where }: { where: { hash: string } }) =>
            where.hash === ORIGINAL_HASH ? { id: 7 } : null,
        )

        await expect(
            L2PSTransactionExecutor.hasExecuted(ORIGINAL_HASH),
        ).resolves.toBe(true)
        await expect(
            L2PSTransactionExecutor.hasExecuted("cd".repeat(32)),
        ).resolves.toBe(false)
    })
})
