/**
 * /health answers 200 only when the node can serve: booted, synced and not
 * dormant. /health/live keeps the old meaning (200 unless the node is
 * failing) for the container healthcheck, which must not mark a node that
 * is still catching up as unhealthy.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const sharedState: Record<string, any> = {}

function resetState() {
    Object.assign(sharedState, {
        version: "test",
        version_name: "test",
        syncStatus: true,
        inSyncLoop: false,
        dormantMode: false,
        isInitialized: true,
        mainLoopSleepTime: 1000,
        mainLoopHeartbeatAt: Date.now(),
        mainLoopExited: false,
        mainLoopExitReason: null,
        mainLoopIterations: 1,
        uncaughtExceptionTotal: 0,
        unhandledRejectionTotal: 0,
        lastUncaughtException: null,
        subsystems: buildInitialSubsystemRegistry(),
        bootTracker: new BootTracker(),
        getUptimeSeconds: () => 1,
        serverPort: 0,
    })
}

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
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => sharedState },
    getSharedState: sharedState,
}))
jest.mock("src/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: { count: async () => 0 },
}))

const { BootTracker, buildInitialSubsystemRegistry } = await import(
    "src/utilities/subsystemRegistry"
)
resetState()

jest.mock("./middleware/rateLimiter", () => ({
    RateLimiter: {
        getInstance: () => ({
            createMiddleware: () => async (_req: any, next: any) => next(),
            getClientIP: () => "127.0.0.1",
            getStats: () => ({}),
            getCurrentLimits: () => null,
        }),
    },
}))

const routes = new Map<string, (req: any) => Promise<Response> | Response>()
const realBunServer = await import("./bunServer")
jest.mock("./bunServer", () => ({
    ...realBunServer,
    BunServer: class {
        server = null
        use() {
            return this
        }
        get(path: string, handler: any) {
            routes.set("GET " + path, handler)
            return this
        }
        post(path: string, handler: any) {
            routes.set("POST " + path, handler)
            return this
        }
        start() {
            return null
        }
    },
}))

const { serverRpcBun } = await import("./server_rpc")
await serverRpcBun()

async function probe(path: string) {
    const handler = routes.get("GET " + path)
    if (!handler) throw new Error(`no route ${path}`)
    const res = await handler(new Request("http://node" + path))
    return { code: res.status, body: (await res.json()) as any }
}

beforeEach(resetState)

describe("/health readiness", () => {
    it("is 200 for a booted, synced node", async () => {
        const { code, body } = await probe("/health")
        expect(code).toBe(200)
        expect(body.ready).toBe(true)
    })

    it("is 503 while the node is dormant", async () => {
        sharedState.dormantMode = true
        const { code, body } = await probe("/health")
        expect(code).toBe(503)
        expect(body.status).toBe("dormant")
        expect(body.ready).toBe(false)
    })

    it("is 503 while the node is not synced", async () => {
        sharedState.syncStatus = false
        const { code, body } = await probe("/health")
        expect(code).toBe(503)
        expect(body.not_ready).toContain("not_synced")
    })

    it("is 503 until boot has reached the main loop", async () => {
        sharedState.isInitialized = false
        const { code, body } = await probe("/health")
        expect(code).toBe(503)
        expect(body.not_ready).toContain("booting")
    })

    it("does not flap while a synced node runs a sync pass", async () => {
        sharedState.inSyncLoop = true
        expect((await probe("/health")).code).toBe(200)
    })
})

describe("/health/live", () => {
    it("stays 200 for a node that is up but not ready", async () => {
        sharedState.syncStatus = false
        sharedState.isInitialized = false
        const { code, body } = await probe("/health/live")
        expect(code).toBe(200)
        expect(body.ready).toBe(false)
    })

    it("stays 200 while dormant", async () => {
        sharedState.dormantMode = true
        expect((await probe("/health/live")).code).toBe(200)
    })

    it("is 503 when the node is failing", async () => {
        sharedState.mainLoopExited = true
        expect((await probe("/health/live")).code).toBe(503)
    })
})
