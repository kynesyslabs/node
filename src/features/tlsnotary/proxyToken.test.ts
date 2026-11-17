/**
 * The proxy's token check under `tlsnVerified`: the token is the chain row a
 * `tlsn_request` wrote, keyed by the request tx hash in the form the SDK
 * sends it (64 lowercase hex, no 0x). The off-chain token only counts
 * retries, under the same id.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const rows = new Map<string, Record<string, unknown>>()
mock.module("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({
                getRepository: () => ({
                    findOneBy: async ({ tokenId }: { tokenId: string }) => rows.get(tokenId) ?? null,
                }),
            }),
        }),
    },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { TLSN_REQUEST_TTL_BLOCKS } from "@/libs/tlsnotary/onchainRequests"
import { TOKEN_CONFIG, TokenStatus, consumeRetry, lookupToken, validateProxyToken } from "./tokenManager"

const OWNER = "0x" + "11".repeat(32)
const HASH = "ab".repeat(32)
const URL_ = "https://api.github.com/user"
const savedForks = getSharedState.forkConfig
const savedTip = getSharedState.lastBlockNumber

function token(extra: Record<string, unknown> = {}) {
    return {
        tokenId: HASH,
        owner: OWNER,
        domain: "api.github.com",
        status: "pending",
        requestHeight: 101,
        expiresAtHeight: 101 + TLSN_REQUEST_TTL_BLOCKS,
        ...extra,
    }
}

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    ;(getSharedState.forkConfig as any).tlsnVerified.activationHeight = 0
    getSharedState.lastBlockNumber = 101
    getSharedState.tlsnTokenStore = null
    rows.clear()
    rows.set(HASH, token())
})

afterEach(() => {
    const timer = getSharedState.tlsnTokenStore?.cleanupTimer
    if (timer) clearInterval(timer)
})

afterAll(() => {
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedTip
    getSharedState.tlsnTokenStore = null
})

describe("validateProxyToken under tlsnVerified", () => {
    it("accepts the request tx hash as the SDK sends it, and counts retries under it", async () => {
        const result = await validateProxyToken(HASH, OWNER, URL_)

        expect(result.valid).toBe(true)
        expect(result.token?.id).toBe(HASH)
        const before = result.token!.retriesLeft
        expect(consumeRetry(HASH, "proxy-1")?.retriesLeft).toBe(before - 1)
    })

    it("reads a 0x or upper-case hash as the same token", async () => {
        const result = await validateProxyToken("0x" + HASH.toUpperCase(), OWNER, URL_)
        expect(result.valid).toBe(true)
        expect(result.token?.id).toBe(HASH)
    })

    it("refuses another owner, another domain, an expired or stored token, and an unknown hash", async () => {
        expect((await validateProxyToken(HASH, "0x" + "22".repeat(32), URL_)).valid).toBe(false)
        expect((await validateProxyToken(HASH, OWNER, "https://discord.com/api")).valid).toBe(false)
        expect((await validateProxyToken("cd".repeat(32), OWNER, URL_)).error).toBe("TOKEN_NOT_FOUND")

        getSharedState.lastBlockNumber = 101 + TLSN_REQUEST_TTL_BLOCKS
        expect((await validateProxyToken(HASH, OWNER, URL_)).valid).toBe(false)

        getSharedState.lastBlockNumber = 101
        rows.set(HASH, token({ status: "stored" }))
        expect((await validateProxyToken(HASH, OWNER, URL_)).valid).toBe(false)
    })

    it("creates nothing for a request that is not on chain", async () => {
        rows.clear()
        await validateProxyToken(HASH, OWNER, URL_)
        expect(getSharedState.tlsnTokenStore?.tokens.size ?? 0).toBe(0)
    })
})

describe("lookupToken under tlsnVerified", () => {
    it("finds a committed request before the proxy has served it", async () => {
        expect(await lookupToken("0x" + HASH)).toEqual({
            id: HASH,
            owner: OWNER,
            domain: "api.github.com",
            status: TokenStatus.PENDING,
            expiresAt: null,
            expiresAtHeight: 101 + TLSN_REQUEST_TTL_BLOCKS,
            retriesLeft: TOKEN_CONFIG.MAX_RETRIES,
        })
        expect(getSharedState.tlsnTokenStore?.tokens.size ?? 0).toBe(0)
    })

    it("reports the retries the proxy spent, then stored and expired from the chain", async () => {
        await validateProxyToken(HASH, OWNER, URL_)
        consumeRetry(HASH, "proxy-1")
        expect((await lookupToken(HASH))?.retriesLeft).toBe(TOKEN_CONFIG.MAX_RETRIES - 1)

        getSharedState.lastBlockNumber = 101 + TLSN_REQUEST_TTL_BLOCKS
        expect((await lookupToken(HASH))?.status).toBe(TokenStatus.EXPIRED)

        rows.set(HASH, token({ status: "stored" }))
        expect((await lookupToken(HASH))?.status).toBe(TokenStatus.STORED)
    })

    it("finds nothing for a hash the chain does not hold", async () => {
        expect(await lookupToken("cd".repeat(32))).toBeNull()
    })
})
