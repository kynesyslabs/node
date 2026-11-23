import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { findProxyAuthPlaceholders, isPlaceholderAuthHash } from "./proxyChecks"

const repo = path.resolve(import.meta.dir, "../..")

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

/** The node service's block of a compose file, up to the service after it. */
function composeNodeService(file: string, nextService: string): string {
    const yml = fs.readFileSync(path.join(repo, file), "utf8")
    const start = yml.indexOf("\n  node:\n")
    const end = yml.indexOf(`\n  ${nextService}:\n`, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return yml.slice(start, end)
}

describe("the proxy check under docker compose", () => {
    // .env is not copied into the image: only the variables listed under the
    // node service reach the container. One the check reads but compose does
    // not pass leaves that part of the check silent under docker.
    it("gets every variable it reads from the compose files", () => {
        const source = fs.readFileSync(path.join(import.meta.dir, "proxyChecks.ts"), "utf8")
        const keys = [...new Set([...source.matchAll(/\benv\.([A-Z_]+)/g)].map(m => m[1]))]
        expect(keys).toContain("MCP_ENABLED")
        const node =
            composeNodeService("docker-compose.yml", "reaper") +
            composeNodeService("docker-compose.proxy.yml", "prometheus")
        for (const key of keys) {
            const listed = new RegExp(`^\\s+${key}: `, "m").test(node)
            expect([key, listed]).toEqual([key, true])
        }
    })

    it("keeps MCP off for an operator who does not set MCP_ENABLED", () => {
        expect(composeNodeService("docker-compose.yml", "reaper")).toMatch(
            /^\s+MCP_ENABLED: \$\{MCP_ENABLED:-false\}$/m,
        )
    })
})
