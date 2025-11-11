/**
 * OmniProtocol Server Startup Integration
 *
 * This module provides a simple way to start the OmniProtocol TCP server
 * alongside the existing HTTP server in the node.
 */

import { OmniProtocolServer } from "../server/OmniProtocolServer"
import log from "src/utilities/logger"

let serverInstance: OmniProtocolServer | null = null

export interface OmniServerConfig {
    enabled?: boolean
    host?: string
    port?: number
    maxConnections?: number
    authTimeout?: number
    connectionTimeout?: number
}

/**
 * Start the OmniProtocol TCP server
 * @param config Server configuration (optional)
 * @returns OmniProtocolServer instance or null if disabled
 */
export async function startOmniProtocolServer(
    config: OmniServerConfig = {}
): Promise<OmniProtocolServer | null> {
    // Check if enabled (default: false for now until fully tested)
    if (config.enabled === false) {
        log.info("[OmniProtocol] Server disabled in configuration")
        return null
    }

    try {
        // Create server with configuration
        serverInstance = new OmniProtocolServer({
            host: config.host ?? "0.0.0.0",
            port: config.port ?? detectDefaultPort(),
            maxConnections: config.maxConnections ?? 1000,
            authTimeout: config.authTimeout ?? 5000,
            connectionTimeout: config.connectionTimeout ?? 600000, // 10 minutes
        })

        // Setup event listeners
        serverInstance.on("listening", (port) => {
            log.info(`[OmniProtocol] ✅ Server listening on port ${port}`)
        })

        serverInstance.on("connection_accepted", (remoteAddress) => {
            log.debug(`[OmniProtocol] 📥 Connection accepted from ${remoteAddress}`)
        })

        serverInstance.on("connection_rejected", (remoteAddress, reason) => {
            log.warn(
                `[OmniProtocol] ❌ Connection rejected from ${remoteAddress}: ${reason}`
            )
        })

        serverInstance.on("error", (error) => {
            log.error(`[OmniProtocol] Server error:`, error)
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
export function getOmniProtocolServer(): OmniProtocolServer | null {
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
