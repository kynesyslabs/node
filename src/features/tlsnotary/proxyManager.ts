/**
 * TLSNotary WebSocket Proxy Manager
 *
 * Manages wstcp proxy processes for domain-specific TLS attestation.
 * Spawns proxies on-demand, monitors activity, and cleans up idle instances.
 *
 * ## Architecture
 *
 * ```
 * SDK Request → requestProxy(targetUrl)
 *                     │
 *                     ▼
 *              ┌──────────────┐
 *              │ Lazy Cleanup │ ─── Kill proxies idle > 30s
 *              └──────────────┘
 *                     │
 *                     ▼
 *              ┌──────────────────┐
 *              │ Check Existing?  │
 *              └──────────────────┘
 *                     │
 *        ┌────────────┴────────────┐
 *        ▼                         ▼
 *    EXISTS                    NOT EXISTS
 *    Update lastActivity       Spawn new wstcp
 *    Return existing           Register & return
 * ```
 *
 * @module features/tlsnotary/proxyManager
 */

// REVIEW: TLSNotary proxy manager - manages wstcp processes for TLS attestation
import { spawn, type ChildProcess } from "child_process"
import { exec } from "child_process"
import { promisify } from "util"
import log from "@/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"
import {
  PORT_CONFIG,
  initPortPool,
  allocatePort,
  releasePort,
  type PortPoolState,
} from "./portAllocator"

const execAsync = promisify(exec)

/**
 * Error codes for proxy operations
 */
export enum ProxyError {
  PROXY_SPAWN_FAILED = "PROXY_SPAWN_FAILED",
  PORT_EXHAUSTED = "PORT_EXHAUSTED",
  INVALID_URL = "INVALID_URL",
  WSTCP_NOT_AVAILABLE = "WSTCP_NOT_AVAILABLE",
}

/**
 * Information about a running proxy
 */
export interface ProxyInfo {
  proxyId: string // uuid
  domain: string // "api.example.com"
  targetPort: number // 443
  port: number // allocated local port (55123)
  process: ChildProcess // wstcp process handle
  lastActivity: number // Date.now() timestamp
  spawnedAt: number // Date.now() timestamp
  websocketProxyUrl: string // "ws://node.demos.sh:55123"
}

/**
 * TLSNotary state stored in sharedState
 */
export interface TLSNotaryState {
  proxies: Map<string, ProxyInfo> // keyed by "domain:port"
  portPool: PortPoolState
}

/**
 * Success response for proxy request
 */
export interface ProxyRequestSuccess {
  websocketProxyUrl: string
  targetDomain: string
  expiresIn: number
  proxyId: string
}

/**
 * Error response for proxy request
 */
export interface ProxyRequestError {
  error: ProxyError
  message: string
  targetDomain?: string
  lastError?: string
}

/**
 * Generate a cryptographically secure UUID
 */
function generateUuid(): string {
  return crypto.randomUUID()
}

/**
 * Get the TLSNotary state, initializing if needed
 */
function getTLSNotaryState(): TLSNotaryState {
  const sharedState = getSharedState
  if (!sharedState.tlsnotary) {
    sharedState.tlsnotary = {
      proxies: new Map<string, ProxyInfo>(),
      portPool: initPortPool(),
    }
    log.info("[TLSNotary] Initialized proxy manager state")
  }
  return sharedState.tlsnotary
}

/**
 * Ensure wstcp binary is available, installing if needed
 * @throws Error if wstcp cannot be found or installed
 */
export async function ensureWstcp(): Promise<void> {
  try {
    await execAsync("which wstcp")
    log.debug("[TLSNotary] wstcp binary found")
  } catch {
    log.info("[TLSNotary] wstcp not found, installing via cargo...")
    try {
      await execAsync("cargo install wstcp")
      log.info("[TLSNotary] wstcp installed successfully")
    } catch (installError: any) {
      throw new Error(`Failed to install wstcp: ${installError.message}`)
    }
  }
}

/**
 * Extract domain and port from a target URL
 * @param targetUrl - Full URL like "https://api.example.com:8443/endpoint"
 * @returns Domain and port extracted from URL
 */
export function extractDomainAndPort(targetUrl: string): {
  domain: string
  port: number
} {
  try {
    const url = new URL(targetUrl)
    const domain = url.hostname

    // If explicit port in URL, use it
    if (url.port) {
      return { domain, port: parseInt(url.port, 10) }
    }

    // Otherwise infer from protocol
    const port = url.protocol === "https:" ? 443 : 80
    return { domain, port }
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`)
  }
}

/**
 * Build the public WebSocket URL for the proxy
 * @param localPort - Local port the proxy is listening on
 * @param requestOrigin - Optional request origin for auto-detection
 * @returns WebSocket URL like "ws://node.demos.sh:55123"
 */
export function getPublicUrl(localPort: number, requestOrigin?: string): string {
  // 1. Try auto-detect from request origin (if available in headers)
  if (requestOrigin) {
    try {
      const url = new URL(requestOrigin)
      return `ws://${url.hostname}:${localPort}`
    } catch {
      // Invalid origin, continue to fallback
    }
  }

  // 2. Fall back to EXPOSED_URL
  if (process.env.EXPOSED_URL) {
    try {
      const url = new URL(process.env.EXPOSED_URL)
      return `ws://${url.hostname}:${localPort}`
    } catch {
      // Invalid EXPOSED_URL, continue to fallback
    }
  }

  // 3. Fall back to sharedState.exposedUrl
  const sharedState = getSharedState
  try {
    const url = new URL(sharedState.exposedUrl)
    return `ws://${url.hostname}:${localPort}`
  } catch {
    // Last resort: localhost
    return `ws://localhost:${localPort}`
  }
}

/**
 * Attach activity monitors to the process
 * Any stdout/stderr activity resets the idle timer
 */
function attachActivityMonitor(
  process: ChildProcess,
  proxyInfo: ProxyInfo,
  state: TLSNotaryState,
): void {
  // Any stdout activity resets the idle timer
  process.stdout?.on("data", (data: Buffer) => {
    proxyInfo.lastActivity = Date.now()
    log.debug(
      `[TLSNotary] Proxy ${proxyInfo.domain} stdout: ${data.toString().trim()}`,
    )
  })

  process.stderr?.on("data", (data: Buffer) => {
    proxyInfo.lastActivity = Date.now()
    log.debug(
      `[TLSNotary] Proxy ${proxyInfo.domain} stderr: ${data.toString().trim()}`,
    )
  })

  process.on("exit", code => {
    log.info(
      `[TLSNotary] Proxy for ${proxyInfo.domain} exited with code ${code}`,
    )
    // Remove from registry
    const key = `${proxyInfo.domain}:${proxyInfo.targetPort}`
    state.proxies.delete(key)
    // Release port back to pool
    releasePort(state.portPool, proxyInfo.port)
  })

  process.on("error", err => {
    log.error(`[TLSNotary] Proxy ${proxyInfo.domain} error: ${err.message}`)
  })
}

/**
 * Spawn a new wstcp proxy process
 * @param domain - Target domain
 * @param targetPort - Target port (usually 443)
 * @param localPort - Local port to bind
 * @param requestOrigin - Optional request origin for URL building
 * @returns ProxyInfo on success
 */
async function spawnProxy(
  domain: string,
  targetPort: number,
  localPort: number,
  requestOrigin?: string,
): Promise<ProxyInfo> {
  const state = getTLSNotaryState()

  // Spawn wstcp: wstcp --bind-addr 0.0.0.0:{port} {domain}:{targetPort}
  const args = ["--bind-addr", `0.0.0.0:${localPort}`, `${domain}:${targetPort}`]
  log.info(`[TLSNotary] Spawning wstcp: wstcp ${args.join(" ")}`)

  const childProcess = spawn("wstcp", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  })

  const proxyId = generateUuid()
  const now = Date.now()
  const websocketProxyUrl = getPublicUrl(localPort, requestOrigin)

  const proxyInfo: ProxyInfo = {
    proxyId,
    domain,
    targetPort,
    port: localPort,
    process: childProcess,
    lastActivity: now,
    spawnedAt: now,
    websocketProxyUrl,
  }

  // Wait for either success (INFO message) or failure (panic/error)
  await new Promise<void>((resolve, reject) => {
    let stderrBuffer = ""
    let resolved = false

    const cleanup = () => {
      resolved = true
      childProcess.stderr?.removeAllListeners("data")
      childProcess.removeAllListeners("error")
      childProcess.removeAllListeners("exit")
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        cleanup()
        // No output after timeout - assume failure
        reject(new Error(`wstcp startup timeout - no response after ${PORT_CONFIG.SPAWN_TIMEOUT_MS}ms`))
      }
    }, PORT_CONFIG.SPAWN_TIMEOUT_MS)

    // wstcp writes all output to stderr (Rust tracing)
    childProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString()
      stderrBuffer += output

      // Check for panic (Rust panic message)
      if (output.includes("panicked at") || output.includes("thread 'main'")) {
        clearTimeout(timeout)
        if (!resolved) {
          cleanup()
          // Extract useful error message
          const addrInUse = stderrBuffer.includes("AddrInUse") || stderrBuffer.includes("Address already in use")
          if (addrInUse) {
            reject(new Error(`Port ${localPort} already in use`))
          } else {
            reject(new Error(`wstcp panic: ${output.trim().substring(0, 200)}`))
          }
        }
        return
      }

      // Check for success (INFO Starts a WebSocket proxy server)
      if (output.includes("INFO") && output.includes("Starts a WebSocket")) {
        clearTimeout(timeout)
        if (!resolved) {
          cleanup()
          log.info(`[TLSNotary] wstcp started successfully on port ${localPort}`)
          resolve()
        }
        return
      }
    })

    childProcess.on("error", err => {
      clearTimeout(timeout)
      if (!resolved) {
        cleanup()
        reject(err)
      }
    })

    childProcess.on("exit", code => {
      clearTimeout(timeout)
      if (!resolved) {
        cleanup()
        if (code !== null && code !== 0) {
          reject(new Error(`wstcp exited with code ${code}: ${stderrBuffer.trim().substring(0, 200)}`))
        }
      }
    })
  })

  // Attach activity monitors after successful spawn
  attachActivityMonitor(childProcess, proxyInfo, state)

  return proxyInfo
}

/**
 * Clean up stale proxies (idle > 30s)
 * Called lazily on each new request
 */
export function cleanupStaleProxies(): void {
  const state = getTLSNotaryState()
  const now = Date.now()
  const staleThreshold = now - PORT_CONFIG.IDLE_TIMEOUT_MS

  for (const [key, proxy] of state.proxies) {
    if (proxy.lastActivity < staleThreshold) {
      log.info(
        `[TLSNotary] Cleaning up stale proxy for ${proxy.domain} (idle ${Math.floor(
          (now - proxy.lastActivity) / 1000,
        )}s)`,
      )
      // Kill the process
      try {
        proxy.process.kill("SIGTERM")
      } catch {
        // Process may have already exited
      }
      // Remove from registry (exit handler will also do this)
      state.proxies.delete(key)
      // Release port
      releasePort(state.portPool, proxy.port)
    }
  }
}

/**
 * Check if a proxy process is still alive
 */
function isProxyAlive(proxy: ProxyInfo): boolean {
  try {
    // Send signal 0 to check if process exists
    return proxy.process.kill(0)
  } catch {
    return false
  }
}

/**
 * Request a proxy for the given target URL
 * Main entry point for the proxy manager
 *
 * @param targetUrl - Full URL like "https://api.example.com/endpoint"
 * @param requestOrigin - Optional request origin for URL building
 * @returns Success or error response
 */
export async function requestProxy(
  targetUrl: string,
  requestOrigin?: string,
): Promise<ProxyRequestSuccess | ProxyRequestError> {
  // 1. Ensure wstcp is available
  try {
    await ensureWstcp()
  } catch (err: any) {
    return {
      error: ProxyError.WSTCP_NOT_AVAILABLE,
      message: err.message,
    }
  }

  // 2. Extract domain and port
  let domain: string
  let targetPort: number
  try {
    const extracted = extractDomainAndPort(targetUrl)
    domain = extracted.domain
    targetPort = extracted.port
  } catch (err: any) {
    return {
      error: ProxyError.INVALID_URL,
      message: err.message,
    }
  }

  // 3. Lazy cleanup of stale proxies
  cleanupStaleProxies()

  const state = getTLSNotaryState()
  const key = `${domain}:${targetPort}`

  // 4. Check if proxy exists and is alive
  const existingProxy = state.proxies.get(key)
  if (existingProxy && isProxyAlive(existingProxy)) {
    // Update lastActivity and return existing
    existingProxy.lastActivity = Date.now()
    log.info(`[TLSNotary] Reusing existing proxy for ${domain}:${targetPort}`)
    return {
      websocketProxyUrl: existingProxy.websocketProxyUrl,
      targetDomain: domain,
      expiresIn: PORT_CONFIG.IDLE_TIMEOUT_MS,
      proxyId: existingProxy.proxyId,
    }
  }

  // 5. Need to spawn a new proxy - try up to MAX_SPAWN_RETRIES times
  let lastError = ""
  for (let attempt = 0; attempt < PORT_CONFIG.MAX_SPAWN_RETRIES; attempt++) {
    // Allocate a port
    const localPort = await allocatePort(state.portPool)
    if (localPort === null) {
      return {
        error: ProxyError.PORT_EXHAUSTED,
        message: "All ports in range 55000-57000 are exhausted",
        targetDomain: domain,
      }
    }

    try {
      const proxyInfo = await spawnProxy(
        domain,
        targetPort,
        localPort,
        requestOrigin,
      )

      // Register in state
      state.proxies.set(key, proxyInfo)
      log.info(
        `[TLSNotary] Spawned proxy for ${domain}:${targetPort} on port ${localPort}`,
      )

      return {
        websocketProxyUrl: proxyInfo.websocketProxyUrl,
        targetDomain: domain,
        expiresIn: PORT_CONFIG.IDLE_TIMEOUT_MS,
        proxyId: proxyInfo.proxyId,
      }
    } catch (err: any) {
      lastError = err.message
      log.warning(
        `[TLSNotary] Spawn attempt ${attempt + 1} failed for ${domain}: ${lastError}`,
      )
      // Release the port since spawn failed
      releasePort(state.portPool, localPort)
    }
  }

  // All attempts failed
  return {
    error: ProxyError.PROXY_SPAWN_FAILED,
    message: `Failed to spawn proxy after ${PORT_CONFIG.MAX_SPAWN_RETRIES} attempts`,
    targetDomain: domain,
    lastError,
  }
}

/**
 * Kill a specific proxy by ID
 * @param proxyId - Proxy UUID to kill
 * @returns True if found and killed
 */
export function killProxy(proxyId: string): boolean {
  const state = getTLSNotaryState()

  for (const [key, proxy] of state.proxies) {
    if (proxy.proxyId === proxyId) {
      log.info(`[TLSNotary] Manually killing proxy ${proxyId} for ${proxy.domain}`)
      try {
        proxy.process.kill("SIGTERM")
      } catch {
        // Process may have already exited
      }
      state.proxies.delete(key)
      releasePort(state.portPool, proxy.port)
      return true
    }
  }

  return false
}

/**
 * Kill all active proxies (cleanup on shutdown)
 */
export function killAllProxies(): void {
  const state = getTLSNotaryState()

  for (const [key, proxy] of state.proxies) {
    log.info(`[TLSNotary] Killing proxy for ${proxy.domain}`)
    try {
      proxy.process.kill("SIGTERM")
    } catch {
      // Process may have already exited
    }
  }

  state.proxies.clear()
  log.info("[TLSNotary] All proxies killed")
}

/**
 * Get current proxy manager status
 */
export function getProxyManagerStatus(): {
  activeProxies: number
  proxies: Array<{
    proxyId: string
    domain: string
    port: number
    idleSeconds: number
  }>
  portPool: {
    allocated: number
    recycled: number
    remaining: number
  }
} {
  const state = getTLSNotaryState()
  const now = Date.now()

  const proxies = Array.from(state.proxies.values()).map(p => ({
    proxyId: p.proxyId,
    domain: p.domain,
    port: p.port,
    idleSeconds: Math.floor((now - p.lastActivity) / 1000),
  }))

  const total = PORT_CONFIG.PORT_MAX - PORT_CONFIG.PORT_MIN + 1
  const remaining =
    state.portPool.max -
    state.portPool.next +
    1 +
    state.portPool.recycled.length
  const allocated = total - remaining

  return {
    activeProxies: state.proxies.size,
    proxies,
    portPool: {
      allocated,
      recycled: state.portPool.recycled.length,
      remaining,
    },
  }
}
