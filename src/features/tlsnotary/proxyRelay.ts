/**
 * In-process WebSocket to TCP relay for TLSNotary provers.
 *
 * Each granted session listens on its own port of the proxy window (the
 * reverse proxy routes /tlsn/<port>/ there) and serves exactly one websocket,
 * whose path must end in the session's secret id. The relay dials only the
 * address the caller's target was checked against, counts the bytes of each
 * direction and ends the session at its byte caps, its lifetime, an idle gap
 * or the close of either side; the port goes back to the pool every time.
 *
 * @module features/tlsnotary/proxyRelay
 */
import { randomBytes, randomUUID, timingSafeEqual } from "crypto"
import type { Server, ServerWebSocket, Socket } from "bun"
import log from "@/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"
import {
    allocatePort,
    initPortPool,
    proxyBindHost,
    releasePort,
    type PortPoolState,
} from "./portAllocator"
import { PORT_CONFIG } from "./constants"

export interface RelayLimits {
    maxLifetimeMs: number
    idleMs: number
    maxSentBytes: number
    maxRecvBytes: number
}

export type RelayEndReason =
    | "client-closed"
    | "target-closed"
    | "target-unreachable"
    | "lifetime"
    | "idle"
    | "sent-cap"
    | "recv-cap"
    | "superseded"
    | "shutdown"
    | "error"

export interface RelaySession {
    /** Public handle, safe to log and return. */
    proxyId: string
    /** Capability in the websocket path; only its owner is told it. */
    sessionId: string
    tokenId: string
    owner: string
    /** Rate-limit subject of the caller's address. */
    clientKey: string
    domain: string
    dialHost: string
    targetPort: number
    port: number
    createdAt: number
    expiresAt: number
    lastActivity: number
    bytesSent: number
    bytesRecv: number
    /** A websocket was accepted; the session never takes a second one. */
    connected: boolean
    refusedHandshakes: number
    limits: RelayLimits
    endedAt?: number
    endReason?: RelayEndReason
    /** Settles when the session has released its port. */
    ended: Promise<RelayEndReason>
}

interface SessionInternals {
    server?: Server
    ws?: ServerWebSocket<unknown>
    tcp?: Socket<unknown>
    toTarget: Uint8Array[]
    tcpReady: boolean
    lifetimeTimer?: ReturnType<typeof setTimeout>
    idleTimer?: ReturnType<typeof setTimeout>
    resolveEnded: (reason: RelayEndReason) => void
}

export interface TLSNotaryState {
    sessions: Map<string, RelaySession>
    portPool: PortPoolState
}

const internals = new WeakMap<RelaySession, SessionInternals>()

export function getTLSNotaryState(): TLSNotaryState {
    const sharedState = getSharedState
    if (!sharedState.tlsnotary) {
        sharedState.tlsnotary = {
            sessions: new Map<string, RelaySession>(),
            portPool: initPortPool(),
        }
    }
    return sharedState.tlsnotary
}

/** Sessions that still hold a port. */
export function liveSessions(): RelaySession[] {
    return [...getTLSNotaryState().sessions.values()]
}

/**
 * The last non-empty path segment: the reverse proxy may or may not strip
 * the /tlsn/<port> prefix before it reaches the relay.
 */
export function sessionIdFromPath(pathname: string): string {
    const parts = pathname.split("/").filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : ""
}

function sameSecret(given: string, expected: string): boolean {
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
}

function byteLength(message: string | Buffer | ArrayBuffer | Uint8Array): number {
    if (typeof message === "string") return Buffer.byteLength(message)
    return message.byteLength
}

function asBytes(message: string | Buffer | ArrayBuffer | Uint8Array): Uint8Array {
    if (typeof message === "string") return Buffer.from(message)
    if (message instanceof ArrayBuffer) return new Uint8Array(message)
    return message
}

function touch(session: RelaySession): void {
    session.lastActivity = Date.now()
    const inner = internals.get(session)
    if (!inner || !session.connected) return
    if (inner.idleTimer) clearTimeout(inner.idleTimer)
    inner.idleTimer = setTimeout(
        () => endRelaySession(session, "idle"),
        session.limits.idleMs,
    )
}

function flushToTarget(session: RelaySession): void {
    const inner = internals.get(session)
    if (!inner?.tcp || !inner.tcpReady) return
    while (inner.toTarget.length > 0) {
        const chunk = inner.toTarget[0]
        const written = inner.tcp.write(chunk)
        if (written < chunk.byteLength) {
            inner.toTarget[0] = chunk.subarray(Math.max(written, 0))
            return
        }
        inner.toTarget.shift()
    }
}

const CLOSE_CODES: Record<RelayEndReason, number> = {
    "client-closed": 1000,
    "target-closed": 1000,
    "target-unreachable": 1011,
    lifetime: 1008,
    idle: 1008,
    "sent-cap": 1009,
    "recv-cap": 1009,
    superseded: 1008,
    shutdown: 1001,
    error: 1011,
}

/** Ends the session and frees its port; a second call does nothing. */
export function endRelaySession(session: RelaySession, reason: RelayEndReason): void {
    if (session.endReason) return
    session.endReason = reason
    session.endedAt = Date.now()
    const inner = internals.get(session)
    const state = getTLSNotaryState()
    state.sessions.delete(session.proxyId)
    if (inner) {
        if (inner.lifetimeTimer) clearTimeout(inner.lifetimeTimer)
        if (inner.idleTimer) clearTimeout(inner.idleTimer)
        inner.toTarget.length = 0
        try {
            inner.ws?.close(CLOSE_CODES[reason], reason)
        } catch {
            // already closed
        }
        try {
            inner.tcp?.end()
        } catch {
            // already closed
        }
        try {
            inner.server?.stop(true)
        } catch {
            // already stopped
        }
    }
    releasePort(state.portPool, session.port)
    log.info(
        `[TLSNotary] Proxy ${session.proxyId} for ${session.domain}:${session.targetPort} ended (${reason}); sent ${session.bytesSent} B, received ${session.bytesRecv} B`,
    )
    inner?.resolveEnded(reason)
}

async function dialTarget(session: RelaySession): Promise<void> {
    const inner = internals.get(session)
    if (!inner) return
    try {
        const tcp = await Bun.connect({
            hostname: session.dialHost,
            port: session.targetPort,
            socket: {
                open() {},
                data(_socket, data) {
                    if (session.endReason) return
                    if (session.bytesRecv + data.byteLength > session.limits.maxRecvBytes) {
                        endRelaySession(session, "recv-cap")
                        return
                    }
                    session.bytesRecv += data.byteLength
                    touch(session)
                    const status = inner.ws?.send(data)
                    // 0 means the websocket is gone and the bytes were dropped.
                    if (status === 0) endRelaySession(session, "client-closed")
                },
                drain() {
                    flushToTarget(session)
                },
                close() {
                    endRelaySession(session, "target-closed")
                },
                end() {
                    endRelaySession(session, "target-closed")
                },
                error(_socket, err) {
                    log.warning(`[TLSNotary] Proxy ${session.proxyId} target error: ${err?.message}`)
                    endRelaySession(session, "error")
                },
                connectError() {
                    endRelaySession(session, "target-unreachable")
                },
            },
        })
        if (session.endReason) {
            tcp.end()
            return
        }
        inner.tcp = tcp
        inner.tcpReady = true
        flushToTarget(session)
    } catch (err: any) {
        log.warning(
            `[TLSNotary] Proxy ${session.proxyId} cannot reach ${session.domain}:${session.targetPort}: ${err?.message}`,
        )
        endRelaySession(session, "target-unreachable")
    }
}

function listen(session: RelaySession, bindHost: string): Server {
    return Bun.serve({
        hostname: bindHost,
        port: session.port,
        fetch(req, server) {
            if (session.endReason) return new Response(null, { status: 410 })
            const id = sessionIdFromPath(new URL(req.url).pathname)
            if (!sameSecret(id, session.sessionId)) {
                session.refusedHandshakes += 1
                return new Response(null, { status: 403 })
            }
            if (session.connected) return new Response(null, { status: 409 })
            if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                return new Response(null, { status: 426 })
            }
            session.connected = true
            if (server.upgrade(req, { data: null })) return undefined
            session.connected = false
            return new Response(null, { status: 400 })
        },
        websocket: {
            maxPayloadLength: session.limits.maxSentBytes,
            // Bytes towards the client are capped per session, so the
            // websocket's own send buffer can never grow past the cap.
            backpressureLimit: session.limits.maxRecvBytes,
            closeOnBackpressureLimit: true,
            idleTimeout: 0,
            open(ws) {
                const inner = internals.get(session)
                if (!inner || session.endReason) {
                    ws.close(1008, "ended")
                    return
                }
                inner.ws = ws
                touch(session)
                void dialTarget(session)
            },
            message(_ws, message) {
                if (session.endReason) return
                const size = byteLength(message)
                if (session.bytesSent + size > session.limits.maxSentBytes) {
                    endRelaySession(session, "sent-cap")
                    return
                }
                session.bytesSent += size
                touch(session)
                internals.get(session)?.toTarget.push(asBytes(message))
                flushToTarget(session)
            },
            close() {
                endRelaySession(session, "client-closed")
            },
        },
    })
}

export interface OpenRelayParams {
    tokenId: string
    owner: string
    clientKey: string
    domain: string
    dialHost: string
    targetPort: number
    limits: RelayLimits
    bindHost?: string
}

/**
 * Opens a session on a free port of the window, or returns null when no
 * port could be bound.
 */
export async function openRelaySession(
    params: OpenRelayParams,
): Promise<RelaySession | "exhausted" | null> {
    const state = getTLSNotaryState()
    const bindHost = params.bindHost ?? proxyBindHost()
    let lastError = ""
    for (let attempt = 0; attempt < PORT_CONFIG.MAX_SPAWN_RETRIES; attempt++) {
        const port = await allocatePort(state.portPool)
        if (port === null) return "exhausted"
        const now = Date.now()
        let resolveEnded: (reason: RelayEndReason) => void = () => {}
        const ended = new Promise<RelayEndReason>(resolve => {
            resolveEnded = resolve
        })
        const session: RelaySession = {
            proxyId: randomUUID(),
            sessionId: randomBytes(32).toString("hex"),
            tokenId: params.tokenId,
            owner: params.owner,
            clientKey: params.clientKey,
            domain: params.domain,
            dialHost: params.dialHost,
            targetPort: params.targetPort,
            port,
            createdAt: now,
            expiresAt: now + params.limits.maxLifetimeMs,
            lastActivity: now,
            bytesSent: 0,
            bytesRecv: 0,
            connected: false,
            refusedHandshakes: 0,
            limits: params.limits,
            ended,
        }
        const inner: SessionInternals = { toTarget: [], tcpReady: false, resolveEnded }
        internals.set(session, inner)
        try {
            inner.server = listen(session, bindHost)
        } catch (err: any) {
            lastError = err?.message ?? String(err)
            internals.delete(session)
            releasePort(state.portPool, port)
            continue
        }
        inner.lifetimeTimer = setTimeout(
            () => endRelaySession(session, "lifetime"),
            params.limits.maxLifetimeMs,
        )
        state.sessions.set(session.proxyId, session)
        log.info(
            `[TLSNotary] Proxy ${session.proxyId} for ${session.domain}:${session.targetPort} listening on ${bindHost}:${port}`,
        )
        return session
    }
    log.warning(`[TLSNotary] Could not bind a proxy port: ${lastError}`)
    return null
}

/** Ends every session, for shutdown and tests. */
export function endAllRelaySessions(): void {
    for (const session of liveSessions()) endRelaySession(session, "shutdown")
}
