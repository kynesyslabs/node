/**
 * `createToken` stores the token as its last step, after logging it. A
 * creation that throws part way, here in its creation log, must leave no
 * token behind: the transaction that asked for it is refused and its fee
 * and nonce restored, so a stored token would be a free attestation.
 *
 * This uses the real token manager; only the logger and the datasource its
 * import chain opens are mocked.
 */

import { afterAll, describe, expect, it, mock } from "bun:test"

const repo = { findOneBy: async () => null }
mock.module("@/model/datasource", () => ({
    __esModule: true,
    dataSource: { getRepository: () => repo },
    default: {
        getInstance: async () => ({ getDataSource: () => ({ getRepository: () => repo }) }),
    },
}))

// Throws on the creation log line while set, as a failing log write would.
let failCreationLog = false
const quiet = () => undefined
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: quiet,
        info: (message: string) => {
            if (failCreationLog && message.includes("Created token")) {
                throw new Error("creation log failed")
            }
        },
        warn: quiet,
        warning: quiet,
        error: quiet,
        critical: quiet,
        only: quiet,
    },
}))

const { getSharedState } = await import("@/utilities/sharedState")
const { createToken, getTokenByTxHash, getTokenStats } = await import("./tokenManager")

const OWNER = "0x" + "11".repeat(32)
const TARGET_URL = "https://example.com/x"

afterAll(() => {
    // The store starts a cleanup interval on first use.
    clearInterval(getSharedState.tlsnTokenStore?.cleanupTimer)
})

describe("createToken", () => {
    it("stores no token when logging the creation throws", () => {
        const txHash = "aa".repeat(32)
        const before = getTokenStats()
        failCreationLog = true
        try {
            expect(() => createToken(OWNER, TARGET_URL, txHash)).toThrow("creation log failed")
        } finally {
            failCreationLog = false
        }
        expect(getTokenByTxHash(txHash)).toBeUndefined()
        expect(getTokenStats()).toEqual(before)
    })

    it("stores the token once the creation is logged", () => {
        const txHash = "bb".repeat(32)
        const before = getTokenStats()
        const token = createToken(OWNER, TARGET_URL, txHash)
        expect(getTokenByTxHash(txHash)).toEqual(token)
        expect(token).toMatchObject({ owner: OWNER, domain: "example.com", txHash })
        const after = getTokenStats()
        expect(after.total).toBe(before.total + 1)
        expect(after.byStatus.pending).toBe(before.byStatus.pending + 1)
    })
})
