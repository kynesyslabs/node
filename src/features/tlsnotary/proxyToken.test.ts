/**
 * The proxy's token under `tlsnVerified`: the chain row a `tlsn_request`
 * wrote, keyed by the request tx hash in the form the SDK sends it (64
 * lowercase hex, no 0x), with the same owner, host, expiry height and single
 * use the store and identity apply judge. Session counts stay this node's.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"

const rows = new Map<string, Record<string, unknown>>()
const repo = {
    findOneBy: async ({ tokenId }: { tokenId: string }) => rows.get(tokenId) ?? null,
}
mock.module("@/model/datasource", () => ({
    __esModule: true,
    dataSource: { getRepository: () => repo },
    default: {
        getInstance: async () => ({ getDataSource: () => ({ getRepository: () => repo }) }),
    },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { TLSN_REQUEST_TTL_BLOCKS } from "@/libs/tlsnotary/onchainRequests"
import { PROXY_LIMITS } from "./constants"
import { authorizeProxyRequest, resetProxyAccessState } from "./proxyAccess"
import { TokenStatus, lookupToken } from "./tokenManager"

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

let ip = 0
const authorize = (tokenId: string, sender = OWNER, targetUrl = URL_) =>
    authorizeProxyRequest({ tokenId, sender, targetUrl, clientIP: `198.51.100.${++ip % 250}` })
const errorOf = (r: Awaited<ReturnType<typeof authorize>>) => ("error" in r ? r.error : "granted")

/** Opens one session for the token, as a served proxy would. */
async function serve(): Promise<void> {
    const grant = await authorize(HASH)
    if (!("commit" in grant)) throw new Error(`refused: ${errorOf(grant)}`)
    grant.commit(`proxy-${ip}`)
}

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    ;(getSharedState.forkConfig as any).tlsnVerified.activationHeight = 0
    getSharedState.lastBlockNumber = 101
    resetProxyAccessState()
    rows.clear()
    rows.set(HASH, token())
})

afterAll(() => {
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedTip
    resetProxyAccessState()
})

describe("proxy access under tlsnVerified", () => {
    it("grants the token row's owner, under the hash as the SDK sends it or with 0x", async () => {
        const grant = await authorize(HASH)
        expect(errorOf(grant)).toBe("granted")
        if (!("commit" in grant)) return
        expect(grant.txHash).toBe(HASH)
        expect(grant.sessionsLeft).toBe(PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN - 1)
        grant.release()
        expect(errorOf(await authorize("0x" + HASH.toUpperCase()))).toBe("granted")
    })

    it("refuses another owner, another host, an unknown hash, an expired or a used token", async () => {
        expect(errorOf(await authorize(HASH, "0x" + "22".repeat(32)))).toBe("TOKEN_OWNER_MISMATCH")
        expect(errorOf(await authorize(HASH, OWNER, "https://discord.com/api"))).toBe("TOKEN_DOMAIN_MISMATCH")
        expect(errorOf(await authorize("cd".repeat(32)))).toBe("TOKEN_NOT_FOUND")

        getSharedState.lastBlockNumber = 101 + TLSN_REQUEST_TTL_BLOCKS
        expect(errorOf(await authorize(HASH))).toBe("TOKEN_EXPIRED")

        getSharedState.lastBlockNumber = 101
        for (const status of ["stored", "linked"]) {
            rows.set(HASH, token({ status }))
            expect(errorOf(await authorize(HASH))).toBe("TOKEN_ALREADY_STORED")
        }
    })

    it("refuses a pre-fork proof row, which is no request", async () => {
        rows.set(HASH, token({ status: "completed", requestHeight: null, expiresAtHeight: null }))
        expect(errorOf(await authorize(HASH))).toBe("TOKEN_NOT_FOUND")
    })

    it("keeps spent sessions past any wall-clock time until the chain token expires", async () => {
        for (let i = 0; i < PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN; i++) await serve()
        const later = Date.now() + 24 * 3600 * 1000
        const again = await authorizeProxyRequest({ tokenId: HASH, sender: OWNER, targetUrl: URL_, clientIP: "198.51.100.251", now: later })
        expect(errorOf(again)).toBe("TOKEN_EXHAUSTED")
    })

    it("bounds a session by the blocks the token has left", async () => {
        getSharedState.lastBlockNumber = 101 + TLSN_REQUEST_TTL_BLOCKS - 1
        const grant = await authorize(HASH)
        if (!("commit" in grant)) throw new Error("refused")
        expect(grant.expiresAtMs - Date.now()).toBeLessThanOrEqual(getSharedState.getConsensusTime() * 1000 + 50)
        grant.release()
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
            retriesLeft: PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN,
        })
    })

    it("reports the sessions the proxy spent, then exhausted, used and expired from the chain", async () => {
        await serve()
        expect((await lookupToken(HASH))?.retriesLeft).toBe(PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN - 1)
        for (let i = 1; i < PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN; i++) await serve()
        expect((await lookupToken(HASH))?.status).toBe(TokenStatus.EXHAUSTED)

        rows.set(HASH, token({ status: "linked" }))
        expect((await lookupToken(HASH))?.status).toBe(TokenStatus.COMPLETED)
        rows.set(HASH, token({ status: "stored" }))
        expect((await lookupToken(HASH))?.status).toBe(TokenStatus.STORED)

        rows.set(HASH, token())
        getSharedState.lastBlockNumber = 101 + TLSN_REQUEST_TTL_BLOCKS
        expect((await lookupToken(HASH))?.status).toBe(TokenStatus.EXPIRED)
    })

    it("finds nothing for a hash the chain does not hold", async () => {
        expect(await lookupToken("cd".repeat(32))).toBeNull()
    })
})
