import { describe, expect, it } from "bun:test"
import { findProxyAuthPlaceholders, isPlaceholderAuthHash } from "./proxyChecks"

const SENTINEL = "$2a$14$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi"
const REAL = "$2a$14$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789."

describe("isPlaceholderAuthHash", () => {
    it.each([undefined, "", "   ", SENTINEL])("treats %p as a placeholder", v => {
        expect(isPlaceholderAuthHash(v)).toBe(true)
    })

    it("accepts a real bcrypt hash", () => {
        expect(isPlaceholderAuthHash(REAL)).toBe(false)
    })
})

describe("findProxyAuthPlaceholders", () => {
    it("refuses a proxy-enabled boot that still has the placeholder", () => {
        expect(
            findProxyAuthPlaceholders({
                PROXY_ENABLED: "true",
                METRICS_BASIC_AUTH_HASH: SENTINEL,
            }),
        ).toEqual(["METRICS_BASIC_AUTH_HASH"])
    })

    it("refuses a proxy-enabled boot with the hash unset", () => {
        expect(findProxyAuthPlaceholders({ PROXY_ENABLED: "true" })).toEqual([
            "METRICS_BASIC_AUTH_HASH",
        ])
    })

    it("boots when the hash is set", () => {
        expect(
            findProxyAuthPlaceholders({
                PROXY_ENABLED: "true",
                METRICS_BASIC_AUTH_HASH: REAL,
            }),
        ).toEqual([])
    })

    it("ignores the placeholder on a non-proxy deployment", () => {
        expect(
            findProxyAuthPlaceholders({
                METRICS_BASIC_AUTH_HASH: SENTINEL,
                MCP_ENABLED: "true",
                MCP_BASIC_AUTH_HASH: SENTINEL,
            }),
        ).toEqual([])
        expect(
            findProxyAuthPlaceholders({
                PROXY_ENABLED: "false",
                METRICS_BASIC_AUTH_HASH: SENTINEL,
            }),
        ).toEqual([])
    })

    it("asks for the MCP hash only when MCP is enabled", () => {
        const env = { PROXY_ENABLED: "true", METRICS_BASIC_AUTH_HASH: REAL }
        expect(findProxyAuthPlaceholders(env)).toEqual([])
        expect(
            findProxyAuthPlaceholders({ ...env, MCP_ENABLED: "true" }),
        ).toEqual(["MCP_BASIC_AUTH_HASH"])
    })

    it("skips the metrics hash when metrics are disabled", () => {
        expect(
            findProxyAuthPlaceholders({
                PROXY_ENABLED: "true",
                METRICS_ENABLED: "false",
            }),
        ).toEqual([])
    })

    it("lets the operator keep a route closed on purpose", () => {
        expect(
            findProxyAuthPlaceholders({
                PROXY_ENABLED: "true",
                PROXY_ALLOW_PLACEHOLDER_AUTH: "true",
            }),
        ).toEqual([])
    })
})
