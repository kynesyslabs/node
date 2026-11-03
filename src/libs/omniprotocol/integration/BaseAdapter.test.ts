/**
 * A peer whose OmniProtocol call failed stays on HTTP for a cooldown in
 * every mode, so a closed Omni port costs one connect timeout rather than
 * one per call.
 */

import { describe, expect, it, jest } from "bun:test"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

const sharedState: Record<string, any> = {
    publicKeyHex: "0xself",
    omniConfig: { port: 0, rateLimit: { enabled: false } },
}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

const { PeerOmniAdapter } = await import("./peerAdapter")
const { DEFAULT_OMNIPROTOCOL_CONFIG } = await import("../types/config")

const PEER = "0x" + "ab".repeat(32)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function adapterWithCooldown(cooldown: number) {
    const adapter = new PeerOmniAdapter({
        config: {
            ...DEFAULT_OMNIPROTOCOL_CONFIG,
            migration: {
                ...DEFAULT_OMNIPROTOCOL_CONFIG.migration,
                httpFallbackCooldown: cooldown,
            },
        },
    })
    adapter.migrationMode = "OMNI_ONLY"
    return adapter
}

describe("HTTP-only cooldown", () => {
    it("keeps a failed peer on HTTP for the cooldown, in OMNI_ONLY mode too", async () => {
        const adapter = adapterWithCooldown(40)
        expect(adapter.shouldUseOmni(PEER)).toBe(true)

        adapter.markHttpPeer(PEER)
        expect(adapter.shouldUseOmni(PEER)).toBe(false)
        expect(adapter.isHttpOnly(PEER)).toBe(true)

        await sleep(50)
        expect(adapter.shouldUseOmni(PEER)).toBe(true)
    })

    it("marking the peer Omni-capable ends the cooldown", () => {
        const adapter = adapterWithCooldown(60_000)
        adapter.markHttpPeer(PEER)
        adapter.markOmniPeer(PEER)
        expect(adapter.shouldUseOmni(PEER)).toBe(true)
    })

    it("sends the next call over HTTP without touching the pool", async () => {
        const adapter = adapterWithCooldown(60_000)
        ;(adapter as any).getPrivateKey = () => Buffer.alloc(64)
        ;(adapter as any).getPublicKey = () => Buffer.alloc(32)
        const sendAuthenticated = jest.fn(async () => {
            throw new Error("Connection timeout after 5000ms")
        })
        ;(adapter as any).connectionPool = { sendAuthenticated }
        const httpCall = jest.fn(async () => ({
            result: 200,
            response: "pong",
            require_reply: false,
            extra: null,
        }))
        const peer = {
            identity: PEER,
            isLocalNode: false,
            connection: { string: "http://10.0.0.9:53550" },
            httpCall,
        } as any

        const request = { method: "ping", params: [] }
        expect((await adapter.adaptCall(peer, request)).result).toBe(200)
        expect((await adapter.adaptCall(peer, request)).result).toBe(200)

        expect(sendAuthenticated).toHaveBeenCalledTimes(1)
        expect(httpCall).toHaveBeenCalledTimes(2)
    })
})
