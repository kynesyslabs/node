import { afterEach, describe, expect, it } from "bun:test"

// Build provenance is read once at import; a PROD load needs it to get as far
// as the outbound checks.
process.env.GIT_COMMIT ||= "a".repeat(40)
const { loadConfig } = await import("./loader")

const KEYS = [
    "PROD",
    "EXPOSED_URL",
    "XM_ENABLED",
    "DEMOSWORK_ENABLED",
    "WEB2_ENABLED",
    "XM_RPC_ALLOWLIST",
    "WEB2_MAX_RESPONSE_BYTES",
    "WEB2_SESSION_TTL_MS",
    "WEB2_INSECURE_TLS",
    "TLSNOTARY_ALLOWED_PORTS",
    "TLSNOTARY_ALLOW_PRIVATE_TARGETS",
] as const
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))

afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
    }
})

describe("outbound request settings", () => {
    it("keep every feature on and every guard closed by default", () => {
        for (const k of KEYS) delete process.env[k]
        expect(loadConfig().outbound).toEqual({
            xmEnabled: true,
            demosWorkEnabled: true,
            web2Enabled: true,
            xmRpcAllowlist: [],
            web2MaxResponseBytes: 10 * 1024 * 1024,
            web2SessionTtlMs: 15 * 60 * 1000,
            web2InsecureTls: false,
            tlsnotaryAllowedPorts: [443],
            tlsnotaryAllowPrivateTargets: false,
        })
    })

    it("read the off switches, the allow-list and the port list", () => {
        process.env.XM_ENABLED = "false"
        process.env.DEMOSWORK_ENABLED = "0"
        process.env.WEB2_ENABLED = "false"
        process.env.XM_RPC_ALLOWLIST = "rpc.a.example, https://rpc.b.example:8545"
        process.env.TLSNOTARY_ALLOWED_PORTS = "443,8443"
        const o = loadConfig().outbound
        expect([o.xmEnabled, o.demosWorkEnabled, o.web2Enabled]).toEqual([
            false,
            false,
            false,
        ])
        expect(o.xmRpcAllowlist).toEqual([
            "rpc.a.example",
            "https://rpc.b.example:8545",
        ])
        expect(o.tlsnotaryAllowedPorts).toEqual([443, 8443])
    })

    it("refuse a zero response cap or session lifetime and a bad port", () => {
        process.env.WEB2_MAX_RESPONSE_BYTES = "0"
        expect(() => loadConfig()).toThrow(/WEB2_MAX_RESPONSE_BYTES/)
        delete process.env.WEB2_MAX_RESPONSE_BYTES

        process.env.WEB2_SESSION_TTL_MS = "-5"
        expect(() => loadConfig()).toThrow(/WEB2_SESSION_TTL_MS/)
        delete process.env.WEB2_SESSION_TTL_MS

        process.env.TLSNOTARY_ALLOWED_PORTS = "443,https"
        expect(() => loadConfig()).toThrow(/TLSNOTARY_ALLOWED_PORTS/)
    })

    it("refuse skipping web2 certificate checks on a production node", () => {
        process.env.WEB2_INSECURE_TLS = "true"
        process.env.PROD = "false"
        expect(loadConfig().outbound.web2InsecureTls).toBe(true)
        process.env.PROD = "true"
        process.env.EXPOSED_URL = "http://203.0.114.7:53550"
        expect(() => loadConfig()).toThrow(/WEB2_INSECURE_TLS/)
    })
})
