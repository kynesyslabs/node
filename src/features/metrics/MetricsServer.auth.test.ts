import { describe, expect, it, mock } from "bun:test"

mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {} },
}))

const { MetricsServer } = await import("./MetricsServer")
const { DEFAULT_CONFIG } = await import("src/config/defaults")

const TOKEN = "s3cret-token"

function serve(bearerToken: string | undefined, path: string, auth?: string) {
    const server = new MetricsServer({ enabled: true, bearerToken }) as any
    const headers: Record<string, string> = auth ? { authorization: auth } : {}
    return server.handleRequest(new Request(`http://localhost${path}`, { headers })) as Promise<Response>
}

describe("metrics server defaults", () => {
    it("binds loopback when METRICS_HOST is unset", () => {
        expect(DEFAULT_CONFIG.metrics.host).toBe("127.0.0.1")
        expect(DEFAULT_CONFIG.metrics.bearerToken).toBe("")
    })
})

describe("metrics bearer token", () => {
    it("serves /metrics without a token configured", async () => {
        expect((await serve(undefined, "/metrics")).status).toBe(200)
        expect((await serve("", "/metrics")).status).toBe(200)
    })

    it("refuses /metrics and / without the configured token", async () => {
        for (const path of ["/metrics", "/"]) {
            for (const auth of [undefined, "Bearer wrong", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
                const res = await serve(TOKEN, path, auth)
                expect(res.status).toBe(401)
                expect(res.headers.get("www-authenticate")).toContain("Bearer")
            }
        }
    })

    it("serves /metrics with the configured token", async () => {
        const res = await serve(TOKEN, "/metrics", `Bearer ${TOKEN}`)
        expect(res.status).toBe(200)
    })

    it("keeps /health open for liveness probes", async () => {
        expect((await serve(TOKEN, "/health")).status).toBe(200)
    })
})
