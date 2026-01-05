/**
 * TLSNotary Port Allocator
 *
 * Manages a pool of ports (55000-57000) for wstcp proxy instances.
 * Uses sequential allocation with recycling of freed ports.
 *
 * @module features/tlsnotary/portAllocator
 */

// REVIEW: TLSNotary port pool management for wstcp proxy instances
import * as net from "net"
import log from "@/utilities/logger"

/**
 * Configuration constants for port allocation
 */
export const PORT_CONFIG = {
  PORT_MIN: 55000,
  PORT_MAX: 57000,
  IDLE_TIMEOUT_MS: 30000, // 30 seconds
  MAX_SPAWN_RETRIES: 3,
  SPAWN_TIMEOUT_MS: 5000, // 5 seconds to wait for wstcp to start
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

    server.once("error", (_err) => {
      // Any error (EADDRINUSE, EACCES, etc.) means port is unavailable
      resolve(false)
    })

    server.once("listening", () => {
      // Port is available - close the server and return true
      server.close((err) => {
        // Resolve even if close fails - port was available
        if (err) {
          resolve(false)
        } else {
          resolve(true)
        }
      })
    })

    server.listen(port, "0.0.0.0")
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
