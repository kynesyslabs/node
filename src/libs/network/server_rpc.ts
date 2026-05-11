/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

import log from "src/utilities/logger"
import sharedState, { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "../peer"
import Chain from "../blockchain/chain"
import Mempool from "../blockchain/mempool"
import { BunServer, cors, json, jsonResponse } from "./bunServer"
import { RateLimiter } from "./middleware/rateLimiter"
import { getAuthContext } from "./authContext"
import { handleError } from "src/errors"

import { isRPCRequest, processPayload, emptyResponse } from "./rpcDispatch"
import { handleIdentityTxRateLimit } from "./rpcRateLimit"
import { registerZkRoutes } from "./zkMerkle"

// Re-export for backward compatibility
export { emptyResponse }

/**
 *  HTTP server using Bun
 */
export async function serverRpcBun() {
    const port = getSharedState.serverPort
    const server = new BunServer(port)

    // Initialize rate limiter
    const rateLimiter = RateLimiter.getInstance()

    // Apply middlewares
    server.use(cors())
    server.use(rateLimiter.createMiddleware())
    server.use(json())

    // ── GET endpoints ─────────────────────────────────────────
    server.get("/", req => {
        const clientIP = rateLimiter.getClientIP(req, server.server)
        return new Response(
            JSON.stringify({
                message: "Hello, World!",
                yourIP: clientIP,
            }),
        )
    })

    server.get("/info", async () => {
        const info = await sharedState.getInstance().getInfo()
        return jsonResponse({
            version: getSharedState.version,
            version_name: getSharedState.version_name,
            ...info,
        })
    })

    server.get("/health", async () => {
        // Accepting traffic only when fully synced and not in the middle of
        // a sync loop.
        const accepting =
            getSharedState.syncStatus && !getSharedState.inSyncLoop

        // Mempool.count() hits the DB; isolate failures so a transient DB
        // outage doesn't 500 the health probe.
        let mempoolSize: number | null = null
        try {
            mempoolSize = await Mempool.count()
        } catch (err) {
            log.error("[/health] Mempool.count() failed:", err)
        }

        const body = {
            version: getSharedState.version,
            version_name: getSharedState.version_name,
            accepting,
            mempool_size: mempoolSize,
            uptime_s: getSharedState.getUptimeSeconds(),
        }

        // Surface health via HTTP status so LB/k8s probes can detect an
        // unhealthy node without parsing the JSON body.
        const healthy = accepting && mempoolSize !== null
        return jsonResponse(body, healthy ? 200 : 503)
    })

    server.get("/version", () => jsonResponse(getSharedState.version))

    server.get("/publickey", () => jsonResponse(getSharedState.publicKeyHex))

    server.get("/connectionstring", async () =>
        jsonResponse(await getSharedState.getConnectionString()),
    )

    server.get("/peerlist", () =>
        jsonResponse(PeerManager.getInstance().getPeers()),
    )

    server.get("/public_logs", () => jsonResponse(log.getPublicLogs()))

    server.get("/diagnostics", () => jsonResponse(log.getDiagnostics()))

    server.get("/mcp", () => {
        return jsonResponse({
            enabled: getSharedState.isMCPServerStarted,
            transport: "sse",
            status: getSharedState.isMCPServerStarted ? "running" : "stopped",
        })
    })

    server.get("/genesis", async () => {
        const genesisBlock = await Chain.getGenesisBlock()
        let genesisData = genesisBlock.content.extra?.genesisData || null

        if (typeof genesisData === "string") {
            genesisData = JSON.parse(genesisData)
        }

        return jsonResponse(genesisData)
    })

    server.get("/rate-limit/stats", () => {
        return jsonResponse(rateLimiter.getStats())
    })

    // ── ZK routes ─────────────────────────────────────────────
    registerZkRoutes(server)

    // ── Main RPC endpoint ─────────────────────────────────────
    server.post("/", async req => {
        try {
            const clientIP = rateLimiter.getClientIP(req, server.server)

            const payload = await req.json()

            const rateLimitResponse = handleIdentityTxRateLimit(
                req,
                clientIP,
                payload,
                rateLimiter,
            )

            if (rateLimitResponse) {
                return rateLimitResponse
            }

            if (!isRPCRequest(payload)) {
                return jsonResponse(
                    { error: "Invalid request format. Not an RPCRequest" },
                    400,
                )
            }

            log.info(
                "[RPC Call] Received request: " + JSON.stringify(payload),
                false,
            )

            const authCtx = getAuthContext(req)
            const sender = authCtx.publicKey || ""
            const response = await processPayload(payload, sender)

            // Surface current rate-limit window so SDK clients can
            // self-throttle (best-effort: skip when no IP data yet).
            const limits = rateLimiter.getCurrentLimits(clientIP)
            const extraHeaders = limits
                ? {
                      "X-RateLimit-Limit": String(limits.limit),
                      "X-RateLimit-Remaining": String(limits.remaining),
                      "X-RateLimit-Reset": String(limits.resetEpochSeconds),
                  }
                : undefined
            return jsonResponse(response, 200, extraHeaders)
        } catch (e) {
            handleError(e, "NETWORK", { source: "serverRpcBun" })
            return jsonResponse({ error: "Invalid request format" }, 400)
        }
    })

    // ── Feature routes (lazy loaded) ──────────────────────────
    if (process.env.TLSNOTARY_ENABLED?.toLowerCase() === "true") {
        try {
            const { registerTLSNotaryRoutes } =
                await import("@/features/tlsnotary/routes")
            registerTLSNotaryRoutes(server)
        } catch (error) {
            log.warning("[RPC] Failed to register TLSNotary routes: " + error)
        }
    }

    try {
        const { registerStorageProgramRoutes } =
            await import("@/features/storageprogram/routes")
        registerStorageProgramRoutes(server)
    } catch (error) {
        log.warning("[RPC] Failed to register StorageProgram routes: " + error)
    }

    log.info("[RPC Call] Server is running on 0.0.0.0:" + port, true)
    server.start()
    return server
}
