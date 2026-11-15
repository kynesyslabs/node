/**
 * The TLSNotary HTTP routes and the notary service must switch on together.
 * The service starts from `Config.tlsnotary.enabled` (TLSNOTARY_ENABLED read
 * with `parseBoolFlag`: "true" or "1"); the routes were gated on a second,
 * stricter reading of the same variable (the word "true" in any case). Runs the
 * real `serverRpcBun` and checks which routes it registers.
 */

import { afterEach, describe, expect, it, mock } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    lastBlockNumber: 10,
    keypair: { publicKey: new Uint8Array(32).fill(7) },
    publicKeyHex: "07".repeat(32),
    SUDO_PUBKEY: "",
    connectionString: "http://us:53550",
    serverPort: 0,
    PROD: false,
    rateLimitConfig: {
        enabled: true,
        defaultLimit: { maxRequests: 100_000, windowMs: 60_000 },
        blockDurationMs: 60_000,
        whitelistedIPs: ["127.0.0.1"],
        whitelistedKeys: [],
        methodLimits: {},
        txPerBlock: 1_000,
    },
}

mockCore(sharedState, { asInstance: true })
mock.module("src/model/datasource", () => ({
    __esModule: true,
    dataSource: {},
    default: {
        getInstance: async () => {
            throw new Error("no database in this test")
        },
    },
}))
mock.module("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set<string>(),
    getStakedSetHeight: () => 0,
    isStaked: async () => false,
    isSelfStaked: async () => false,
    onSelfStakeChange: () => () => undefined,
    invalidateStakedSet: () => undefined,
    __resetStakedSet: () => undefined,
}))

const { BunServer } = await import("./bunServer")
BunServer.prototype.start = function () {
    return null as any
}
const { Config } = await import("src/config")
const { serverRpcBun } = await import("./server_rpc")

const original = process.env.TLSNOTARY_ENABLED

afterEach(() => {
    if (original === undefined) delete process.env.TLSNOTARY_ENABLED
    else process.env.TLSNOTARY_ENABLED = original
    Config.resetInstance()
})

/** Starts the RPC server with TLSNOTARY_ENABLED set to `value` (unset when undefined). */
async function routesFor(value: string | undefined) {
    if (value === undefined) delete process.env.TLSNOTARY_ENABLED
    else process.env.TLSNOTARY_ENABLED = value
    Config.resetInstance()
    const server: any = await serverRpcBun()
    const routes: Map<string, Map<string, unknown>> = server.routes
    return {
        configEnabled: Config.getInstance().tlsnotary.enabled,
        health: routes.get("GET")?.has("/tlsnotary/health") ?? false,
        info: routes.get("GET")?.has("/tlsnotary/info") ?? false,
        verify: routes.get("POST")?.has("/tlsnotary/verify") ?? false,
    }
}

describe("TLSNotary routes follow Config.tlsnotary.enabled", () => {
    for (const value of ["true", "1"]) {
        it(`TLSNOTARY_ENABLED=${value} starts the service and registers the routes`, async () => {
            expect(await routesFor(value)).toEqual({
                configEnabled: true,
                health: true,
                info: true,
                verify: true,
            })
        })
    }

    // parseBoolFlag is case-sensitive, so Config reads TRUE as off.
    for (const value of ["TRUE", "false", "0", undefined]) {
        it(`TLSNOTARY_ENABLED=${value ?? "(unset)"} neither starts the service nor registers the routes`, async () => {
            expect(await routesFor(value)).toEqual({
                configEnabled: false,
                health: false,
                info: false,
                verify: false,
            })
        })
    }
})
