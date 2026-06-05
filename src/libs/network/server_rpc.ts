/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

import log from "src/utilities/logger"
import sharedState, { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "../peer"
import Chain from "../blockchain/chain"
import Mempool from "../blockchain/mempool"
import GCR from "../blockchain/gcr/gcr"
import { BunServer, cors, json, jsonResponse } from "./bunServer"
import { RateLimiter } from "./middleware/rateLimiter"
import { getAuthContext } from "./authContext"
import { handleError } from "src/errors"

import { isRPCRequest, processPayload, emptyResponse } from "./rpcDispatch"
import { handleIdentityTxRateLimit } from "./rpcRateLimit"
import { registerZkRoutes } from "./zkMerkle"
import {
    ConcurrencyGate,
    GateRejectedError,
    GateTimeoutError,
} from "./utils/concurrencyGate"
import {
    IDENTITIES_MAX_CONCURRENT,
    IDENTITIES_MAX_QUEUE,
    IDENTITIES_ACQUIRE_TIMEOUT_MS,
} from "src/utilities/constants"

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

    // Global concurrency gate for the expensive /identities full-table read.
    // Per-IP rate limiting (above) stops a single source flooding; this gate
    // caps TOTAL in-flight /identities work across ALL callers so a
    // distributed (many-IP) burst still can't pile unbounded DB load. Overflow
    // callers queue briefly, then get a fast 503 rather than waiting forever.
    const identitiesGate = new ConcurrencyGate({
        maxConcurrent: IDENTITIES_MAX_CONCURRENT,
        maxQueue: IDENTITIES_MAX_QUEUE,
        acquireTimeoutMs: IDENTITIES_ACQUIRE_TIMEOUT_MS,
    })

    // Apply middlewares
    // server.use(async (req, next) => {
    //     const url = new URL(req.url)
    //     let bodyLog = ""
    //     if (req.method === "POST") {
    //         try {
    //             const cloned = req.clone()
    //             const body = await cloned.text()
    //             bodyLog = body.length > 1024
    //                 ? body.slice(0, 768) + "...(truncated)..." + body.slice(-256)
    //                 : body
    //         } catch {
    //             bodyLog = "(unreadable body)"
    //         }
    //     }
    //     const requestStart = performance.now()
    //     const response = await next()
    //     const durationMs = (performance.now() - requestStart).toFixed(2)
    //     const message = bodyLog
    //         ? `[HTTP] ${req.method} ${url.pathname} -> ${response.status} (${durationMs}ms) body: ${bodyLog}`
    //         : `[HTTP] ${req.method} ${url.pathname} -> ${response.status} (${durationMs}ms)`
    //     log.only(message, false)
    //     return response
    // })
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
        // PR #797 contract — preserve every field so SDK probes do not
        // break. New blocks are additive (Epic 13 T7):
        //   - `status`: ok | degraded | dormant | failing
        //   - `dormant`: true when peer list was empty at boot
        //   - `boot`: counts of step states + name of running step (if any)
        //   - `subsystems`: per-subsystem registry snapshot
        //   - `ports`: requested vs actual for drift visibility
        //   - `errors`: counters from the uncaughtException hooks
        const {
            snapshotSubsystems,
            KNOWN_SUBSYSTEMS,
        } = await import("@/utilities/subsystemRegistry")

        const accepting =
            getSharedState.syncStatus && !getSharedState.inSyncLoop

        let mempoolSize: number | null = null
        try {
            mempoolSize = await Mempool.count()
        } catch (err) {
            log.error("[/health] Mempool.count() failed: " + (err instanceof Error ? err.message : String(err)))
        }

        const subsystems = snapshotSubsystems(getSharedState.subsystems)
        const bootSummary = getSharedState.bootTracker.summary()

        // mainLoop heartbeat staleness — if it's been over 3× the
        // configured sleep time since the last tick (or never), treat as
        // dead. dormantMode is handled separately below.
        const sleepMs = getSharedState.mainLoopSleepTime || 1000
        const heartbeatThresholdMs = Math.max(sleepMs * 3, 30_000)
        const hbAt = getSharedState.mainLoopHeartbeatAt
        const heartbeatAgeMs = hbAt ? Date.now() - hbAt : null
        const mainLoopDead =
            getSharedState.mainLoopExited ||
            (hbAt !== null && heartbeatAgeMs! > heartbeatThresholdMs)
        if (mainLoopDead && subsystems.main_loop) {
            subsystems.main_loop.status = "failed"
        }

        // Status precedence: failing > dormant > degraded > ok
        let status: "ok" | "degraded" | "dormant" | "failing"
        const dbDown = mempoolSize === null
        if (
            dbDown ||
            subsystems.chain?.status === "failed" ||
            (mainLoopDead && !getSharedState.dormantMode)
        ) {
            status = "failing"
        } else if (getSharedState.dormantMode) {
            status = "dormant"
        } else {
            const anyOptionalFailed = Object.values(subsystems).some(
                s => s.status === "failed",
            )
            status = anyOptionalFailed ? "degraded" : "ok"
        }

        const portInfo: Record<
            string,
            { requested: number | null; actual: number | null; drifted: boolean }
        > = {}
        for (const name of KNOWN_SUBSYSTEMS) {
            const s = subsystems[name]
            if (!s) continue
            const requested = s.requestedPort ?? null
            const actual = s.port ?? null
            if (requested === null && actual === null) continue
            portInfo[name] = {
                requested,
                actual,
                drifted:
                    requested !== null &&
                    actual !== null &&
                    requested !== actual,
            }
        }

        const body = {
            version: getSharedState.version,
            version_name: getSharedState.version_name,
            accepting,
            mempool_size: mempoolSize,
            uptime_s: getSharedState.getUptimeSeconds(),
            status,
            dormant: getSharedState.dormantMode,
            boot: {
                complete: bootSummary.complete,
                steps_total: bootSummary.total,
                steps_ready: bootSummary.ready,
                steps_failed: bootSummary.failed,
                steps_skipped: bootSummary.skipped,
                current: bootSummary.current,
            },
            subsystems,
            ports: portInfo,
            main_loop: {
                heartbeat_age_s:
                    heartbeatAgeMs === null
                        ? null
                        : Math.round(heartbeatAgeMs / 1000),
                iterations_total: getSharedState.mainLoopIterations,
                exited: getSharedState.mainLoopExited,
                exit_reason: getSharedState.mainLoopExitReason,
            },
            errors: {
                uncaught_total: getSharedState.uncaughtExceptionTotal,
                unhandled_rejection_total:
                    getSharedState.unhandledRejectionTotal,
                last_uncaught: getSharedState.lastUncaughtException,
            },
        }

        // Surface health via HTTP status so LB/k8s probes can detect an
        // unhealthy node without parsing the JSON body. Dormant + degraded
        // are 200 (intentional state), failing is 503.
        const httpStatus = status === "failing" ? 503 : 200
        const extraHeaders: Record<string, string> = {}
        if (status === "dormant") {
            extraHeaders["X-Demos-Dormant"] = "true"
        }
        return jsonResponse(body, httpStatus, extraHeaders)
    })

    // Slim sibling endpoint for ops dashboards that only need the
    // subsystem state. Same data as /health.subsystems, smaller body.
    server.get("/health/subsystems", async () => {
        const { snapshotSubsystems } = await import(
            "@/utilities/subsystemRegistry"
        )
        return jsonResponse({
            dormant: getSharedState.dormantMode,
            subsystems: snapshotSubsystems(getSharedState.subsystems),
        })
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
        try {
            const genesisBlock = await Chain.getGenesisBlock()
            let genesisData = genesisBlock.content.extra?.genesisData || null

            if (typeof genesisData === "string") {
                try {
                    genesisData = JSON.parse(genesisData)
                } catch (_e) {
                    return jsonResponse({ result: 503, response: "STATE_NOT_READY", extra: { message: "Corrupt genesis data" } }, 503)
                }
            }

            return jsonResponse(genesisData)
        } catch (e) {
            return jsonResponse({ result: 503, response: "STATE_NOT_READY", extra: { message: e instanceof Error ? e.message : String(e) } }, 503)
        }
    })

    // Full genesis block (block 0) — the entire stored Blocks record,
    // not just the embedded genesisData that /genesis returns.
    server.get("/genesisBlock", async () => {
        try {
            const genesisBlock = await Chain.getGenesisBlock()
            if (!genesisBlock) {
                return jsonResponse(
                    {
                        result: 503,
                        response: "STATE_NOT_READY",
                        extra: { message: "Genesis block not found" },
                    },
                    503,
                )
            }
            return jsonResponse(genesisBlock)
        } catch (e) {
            return jsonResponse(
                {
                    result: 503,
                    response: "STATE_NOT_READY",
                    extra: {
                        message: e instanceof Error ? e.message : String(e),
                    },
                },
                503,
            )
        }
    })

    // Paginated listing of every account's linked identities (pubkey +
    // identities blob only). Query params: ?limit=<1-1000>&cursor=<pubkey>.
    // Keyset pagination — pass the response's `nextCursor` back as `cursor`
    // to fetch the next page; a null nextCursor means the end of the table.
    //
    // Wrapped in the global concurrency gate: at most IDENTITIES_MAX_CONCURRENT
    // of these run at once. Overflow callers queue up to IDENTITIES_MAX_QUEUE
    // deep and wait at most IDENTITIES_ACQUIRE_TIMEOUT_MS for a slot, after
    // which (or if the queue is already full) they get a 503 + Retry-After
    // instead of adding to the DB load.
    server.get("/identities", async req => {
        const url = new URL(req.url)
        const limitParam = url.searchParams.get("limit")
        const cursorParam = url.searchParams.get("cursor") || undefined
        const limit = limitParam ? Number(limitParam) : undefined

        try {
            const result = await identitiesGate.run(() =>
                GCR.listIdentities(limit, cursorParam),
            )
            const httpStatus = result.result === 200 ? 200 : 500
            return jsonResponse(result.response, httpStatus)
        } catch (e) {
            if (
                e instanceof GateTimeoutError ||
                e instanceof GateRejectedError
            ) {
                const retryAfterSecs = Math.ceil(
                    IDENTITIES_ACQUIRE_TIMEOUT_MS / 1000,
                )
                return jsonResponse(
                    {
                        success: false,
                        error: "Service busy",
                        message:
                            "Too many concurrent /identities requests; retry shortly.",
                    },
                    503,
                    { "Retry-After": String(retryAfterSecs) },
                )
            }
            // Anything else is a genuine failure, not backpressure.
            log.error(
                "[/identities] unexpected error: " +
                    (e instanceof Error ? e.message : String(e)),
            )
            return jsonResponse(
                {
                    success: false,
                    error: "Failed to list identities",
                    message: e instanceof Error ? e.message : String(e),
                },
                500,
            )
        }
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
