/**
 * OmniProtocol Server Startup Integration
 *
 * This module provides a simple way to start the OmniProtocol TCP server
 * alongside the existing HTTP server in the node.
 * Supports both plain TCP and TLS-encrypted connections.
 */

import { OmniProtocolServer } from "../server/OmniProtocolServer"
import { TLSServer } from "../server/TLSServer"
import { initializeTLSCertificates } from "../tls/initialize"
import type { TLSConfig } from "../tls/types"
import type { RateLimitConfig } from "../ratelimit/types"
import log from "src/utilities/logger"

let serverInstance: OmniProtocolServer | TLSServer | null = null

export interface OmniServerConfig {
    enabled?: boolean
    host?: string
    port?: number
    maxConnections?: number
    authTimeout?: number
    connectionTimeout?: number
    tls?: {
        enabled?: boolean
        mode?: "self-signed" | "ca"
        certPath?: string
        keyPath?: string
        caPath?: string
        minVersion?: "TLSv1.2" | "TLSv1.3"
    }
    rateLimit?: Partial<RateLimitConfig>
}

/**
 * Start the OmniProtocol TCP/TLS server
 * @param config Server configuration (optional)
 * @returns OmniProtocolServer or TLSServer instance, or null if disabled
 */
export async function startOmniProtocolServer(
    config: OmniServerConfig = {},
): Promise<OmniProtocolServer | TLSServer | null> {
    // Check if enabled (default: false for now until fully tested)
    if (config.enabled === false) {
        log.info("[OmniProtocol] Server disabled in configuration")
        return null
    }

    try {
        const port = config.port ?? detectDefaultPort()
        const host = config.host ?? "0.0.0.0"
        const maxConnections = config.maxConnections ?? 1000
        const authTimeout = config.authTimeout ?? 5000
        const connectionTimeout = config.connectionTimeout ?? 600000

        // Check if TLS is enabled
        if (config.tls?.enabled) {
            log.info("[OmniProtocol] Starting with TLS encryption...")

            // Initialize certificates
            let certPath = config.tls.certPath
            let keyPath = config.tls.keyPath

            if (!certPath || !keyPath) {
                log.info("[OmniProtocol] No certificate paths provided, initializing self-signed certificates...")
                const certInit = await initializeTLSCertificates()
                certPath = certInit.certPath
                keyPath = certInit.keyPath
            }

            // Build TLS config
            const tlsConfig: TLSConfig = {
                enabled: true,
                mode: config.tls.mode ?? "self-signed",
                certPath,
                keyPath,
                caPath: config.tls.caPath,
                rejectUnauthorized: false, // Custom verification
                minVersion: config.tls.minVersion ?? "TLSv1.3",
                requestCert: true,
                trustedFingerprints: new Map(),
            }

            // Create TLS server
            serverInstance = new TLSServer({
                host,
                port,
                maxConnections,
                authTimeout,
                connectionTimeout,
                tls: tlsConfig,
                rateLimit: config.rateLimit,
            })

            log.info(`[OmniProtocol] TLS server configured (${tlsConfig.mode} mode, ${tlsConfig.minVersion})`)
        } else {
            // Create plain TCP server
            serverInstance = new OmniProtocolServer({
                host,
                port,
                maxConnections,
                authTimeout,
                connectionTimeout,
                rateLimit: config.rateLimit,
            })

            log.info("[OmniProtocol] Plain TCP server configured (no encryption)")
        }

        // Setup event listeners
        serverInstance.on("listening", (port) => {
            log.info(`[OmniProtocol] ✅ Server listening on port ${port}`)
        })

        serverInstance.on("connection_accepted", (remoteAddress) => {
            log.debug(`[OmniProtocol] 📥 Connection accepted from ${remoteAddress}`)
        })

        serverInstance.on("connection_rejected", (remoteAddress, reason) => {
            log.warn(
                `[OmniProtocol] ❌ Connection rejected from ${remoteAddress}: ${reason}`,
            )
        })

        serverInstance.on("rate_limit_exceeded", (ipAddress, result) => {
            log.warn(
                `[OmniProtocol] ⚠️  Rate limit exceeded for ${ipAddress}: ${result.reason} (${result.currentCount}/${result.limit})`,
            )
        })

        serverInstance.on("error", (error) => {
            log.error("[OmniProtocol] Server error:", error)
        })

        // Start server
        await serverInstance.start()

        log.info("[OmniProtocol] Server started successfully")
        return serverInstance
    } catch (error) {
        log.error("[OmniProtocol] Failed to start server:", error)
        throw error
    }
}

/**
 * Stop the OmniProtocol server
 */
export async function stopOmniProtocolServer(): Promise<void> {
    if (!serverInstance) {
        return
    }

    try {
        log.info("[OmniProtocol] Stopping server...")
        await serverInstance.stop()
        serverInstance = null
        log.info("[OmniProtocol] Server stopped successfully")
    } catch (error) {
        log.error("[OmniProtocol] Error stopping server:", error)
        throw error
    }
}

/**
 * Get the current server instance
 */
export function getOmniProtocolServer(): OmniProtocolServer | TLSServer | null {
    return serverInstance
}

/**
 * Get server statistics
 */
export function getOmniProtocolServerStats() {
    if (!serverInstance) {
        return null
    }
    return serverInstance.getStats()
}

/**
 * Detect default port (HTTP port + 1)
 */
function detectDefaultPort(): number {
    const httpPort = parseInt(process.env.NODE_PORT || process.env.PORT || "3000")
    return httpPort + 1
}

// Example usage in src/index.ts:
//
// import { startOmniProtocolServer, stopOmniProtocolServer } from "./libs/omniprotocol/integration/startup"
//
// // After HTTP server starts:
// const omniServer = await startOmniProtocolServer({
//     enabled: true,  // Set to true to enable
//     port: 3001,
// })
//
// // On node shutdown:
// await stopOmniProtocolServer()
