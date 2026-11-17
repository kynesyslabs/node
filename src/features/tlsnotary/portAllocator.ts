/**
 * TLSNotary Port Allocator
 *
 * Manages the pool of ports (TLSNOTARY_PROXY_PORT_MIN-MAX) for proxy sessions.
 * Uses sequential allocation with recycling of freed ports.
 *
 * @module features/tlsnotary/portAllocator
 */

import * as net from "net"
import log from "@/utilities/logger"
// Single source of truth for the proxy port window, so the env-overridable
// range (TLSNOTARY_PROXY_PORT_MIN/MAX) actually drives allocation — a local
// hardcoded copy here would silently ignore the published host range.
import { PORT_CONFIG } from "./constants"

/**
 * Address the per-session proxy listeners bind. Loopback unless the operator
 * says otherwise: the reverse proxy on this host is the only intended client.
 * Under docker compose the node sets 0.0.0.0, because Caddy reaches the node
 * over the compose network and the host publishes the window on loopback.
 */
export function proxyBindHost(): string {
    return process.env.WSTCP_BIND_HOST || "127.0.0.1"
}

/**
 * Port pool state interface
 */
export interface PortPoolState {
    next: number // next port to try (55000-57000)
    max: number // 57000
    recycled: number[] // freed ports available for reuse
}

/**
 * Initialize a new port pool state
 * @returns Fresh port pool state
 */
export function initPortPool(): PortPoolState {
    return {
        next: PORT_CONFIG.PORT_MIN,
        max: PORT_CONFIG.PORT_MAX,
        recycled: [],
    }
}

/**
 * Check if a port is available by attempting to bind to it
 * @param port - Port number to check
 * @returns True if port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const server = net.createServer()
        let settled = false

        const timer = setTimeout(() => {
            try {
                server.close()
            } finally {
                finish(false)
            }
        }, PORT_CONFIG.SPAWN_TIMEOUT_MS)

        const finish = (available: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(available)
        }

        server.once("error", () => {
            try {
                server.close()
            } finally {
                finish(false)
            }
        })

        server.once("listening", () => {
            server.close(() => finish(true))
        })

        // Probe the host the relay will bind, or a port taken on one
        // address reads as free on the other.
        server.listen(port, proxyBindHost())
    })
}

/**
 * Allocate a port from the pool
 * First tries recycled ports, then sequential allocation
 * @param pool - Port pool state
 * @returns Allocated port number or null if exhausted
 */
export async function allocatePort(
    pool: PortPoolState,
): Promise<number | null> {
    // First try recycled ports
    while (pool.recycled.length > 0) {
        const recycledPort = pool.recycled.pop()!
        if (await isPortAvailable(recycledPort)) {
            log.debug(`[TLSNotary] Allocated recycled port: ${recycledPort}`)
            return recycledPort
        }
        // Port was recycled but is now in use, skip it
        log.debug(
            `[TLSNotary] Recycled port ${recycledPort} is in use, trying next`,
        )
    }

    // Try sequential allocation
    while (pool.next <= pool.max) {
        const port = pool.next
        pool.next++

        if (await isPortAvailable(port)) {
            log.debug(`[TLSNotary] Allocated sequential port: ${port}`)
            return port
        }
        // Port in use, try next
        log.debug(`[TLSNotary] Port ${port} is in use, trying next`)
    }

    // All ports exhausted
    log.warning("[TLSNotary] Port pool exhausted")
    return null
}

/**
 * Release a port back to the recycled pool
 * @param pool - Port pool state
 * @param port - Port number to release
 */
export function releasePort(pool: PortPoolState, port: number): void {
    // Only recycle valid ports
    if (port >= PORT_CONFIG.PORT_MIN && port <= PORT_CONFIG.PORT_MAX) {
        // Avoid duplicates
        if (!pool.recycled.includes(port)) {
            pool.recycled.push(port)
            log.debug(`[TLSNotary] Released port ${port} to recycled pool`)
        }
    }
}

/**
 * Get current pool statistics
 * @param pool - Port pool state
 * @returns Pool statistics object
 */
export function getPoolStats(pool: PortPoolState): {
    allocated: number
    recycled: number
    remaining: number
    total: number
} {
    const total = PORT_CONFIG.PORT_MAX - PORT_CONFIG.PORT_MIN + 1
    const remaining = pool.max - pool.next + 1 + pool.recycled.length
    const allocated = total - remaining

    return {
        allocated,
        recycled: pool.recycled.length,
        remaining,
        total,
    }
}
