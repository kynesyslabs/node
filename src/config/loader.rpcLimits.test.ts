import { afterEach, describe, expect, it } from "bun:test"
import { loadConfig } from "./loader"

const KEYS = [
    "RPC_BIND",
    "RPC_MAX_BODY_BYTES",
    "RPC_PEER_MAX_BODY_BYTES",
    "RATE_LIMIT_BLOCK_DURATION_MS",
] as const
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))

afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
    }
})

describe("RPC limit settings", () => {
    it("defaults to all interfaces, a 4 MiB public body, a 64 MiB peer body and a 60 s block", () => {
        for (const k of KEYS) delete process.env[k]
        const { server, core } = loadConfig()
        expect(server.rpcBind).toBe("0.0.0.0")
        expect(server.rpcMaxBodyBytes).toBe(4 * 1024 * 1024)
        expect(server.rpcPeerMaxBodyBytes).toBe(64 * 1024 * 1024)
        expect(core.rateLimitBlockDurationMs).toBe(60_000)
    })

    it("reads the overrides", () => {
        process.env.RPC_BIND = "127.0.0.1"
        process.env.RPC_MAX_BODY_BYTES = "1048576"
        process.env.RPC_PEER_MAX_BODY_BYTES = "2097152"
        process.env.RATE_LIMIT_BLOCK_DURATION_MS = "5000"
        const { server, core } = loadConfig()
        expect(server.rpcBind).toBe("127.0.0.1")
        expect(server.rpcMaxBodyBytes).toBe(1048576)
        expect(server.rpcPeerMaxBodyBytes).toBe(2097152)
        expect(core.rateLimitBlockDurationMs).toBe(5000)
    })

    it("rejects a peer ceiling below the public limit", () => {
        process.env.RPC_MAX_BODY_BYTES = "2000"
        process.env.RPC_PEER_MAX_BODY_BYTES = "1000"
        expect(() => loadConfig()).toThrow(/RPC_PEER_MAX_BODY_BYTES \(1000\).*RPC_MAX_BODY_BYTES \(2000\)/)
    })

    it("rejects a non-positive body limit or block duration", () => {
        process.env.RPC_MAX_BODY_BYTES = "0"
        expect(() => loadConfig()).toThrow(/RPC_MAX_BODY_BYTES must be a positive integer/)
        delete process.env.RPC_MAX_BODY_BYTES

        process.env.RATE_LIMIT_BLOCK_DURATION_MS = "0"
        expect(() => loadConfig()).toThrow(/RATE_LIMIT_BLOCK_DURATION_MS must be a positive integer/)
    })
})
