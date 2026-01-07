/**
 * OmniProtocol Base Adapter
 *
 * Base class for OmniProtocol adapters providing shared utilities:
 * - Configuration management
 * - Connection pool access
 * - URL conversion (HTTP → TCP)
 * - Migration mode logic
 * - Peer capability tracking
 * - Fatal error handling
 */

import log from "src/utilities/logger"
import {
    DEFAULT_OMNIPROTOCOL_CONFIG,
    MigrationMode,
    OmniProtocolConfig,
} from "../types/config"
import { ConnectionPool } from "../transport/ConnectionPool"
import { OmniProtocolError } from "../types/errors"
import { getNodePrivateKey, getNodePublicKey } from "./keys"

export interface BaseAdapterOptions {
    config?: OmniProtocolConfig
}

/**
 * Deep clone OmniProtocolConfig to avoid mutation
 */
function cloneConfig(config: OmniProtocolConfig): OmniProtocolConfig {
    return {
        pool: { ...config.pool },
        migration: {
            ...config.migration,
            omniPeers: new Set(config.migration.omniPeers),
        },
        protocol: { ...config.protocol },
    }
}

/**
 * Base adapter class with shared OmniProtocol utilities
 */
export abstract class BaseOmniAdapter {
    protected readonly config: OmniProtocolConfig
    protected readonly connectionPool: ConnectionPool

    constructor(options: BaseAdapterOptions = {}) {
        this.config = cloneConfig(
            options.config ?? DEFAULT_OMNIPROTOCOL_CONFIG,
        )

        // Initialize ConnectionPool with configuration
        this.connectionPool = new ConnectionPool({
            maxTotalConnections: this.config.pool.maxTotalConnections,
            maxConnectionsPerPeer: this.config.pool.maxConnectionsPerPeer,
            idleTimeout: this.config.pool.idleTimeout,
            connectTimeout: this.config.pool.connectTimeout,
            authTimeout: this.config.pool.authTimeout,
        })
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Migration Mode Management
    // ─────────────────────────────────────────────────────────────────────────────

    get migrationMode(): MigrationMode {
        return this.config.migration.mode
    }

    set migrationMode(mode: MigrationMode) {
        this.config.migration.mode = mode
    }

    get omniPeers(): Set<string> {
        return this.config.migration.omniPeers
    }

    /**
     * Check if OmniProtocol should be used for a peer based on migration mode
     */
    shouldUseOmni(peerIdentity: string): boolean {
        const { mode, omniPeers } = this.config.migration

        switch (mode) {
            case "HTTP_ONLY":
                return false
            case "OMNI_PREFERRED":
                return omniPeers.has(peerIdentity)
            case "OMNI_ONLY":
                return true
            default:
                return false
        }
    }

    /**
     * Mark a peer as OmniProtocol-capable
     */
    markOmniPeer(peerIdentity: string): void {
        this.config.migration.omniPeers.add(peerIdentity)
    }

    /**
     * Mark a peer as HTTP-only (e.g., after OmniProtocol failure)
     */
    markHttpPeer(peerIdentity: string): void {
        this.config.migration.omniPeers.delete(peerIdentity)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // URL Conversion Utilities
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Convert HTTP(S) URL to TCP connection string for OmniProtocol
     * @param httpUrl HTTP URL (e.g., "http://localhost:53550")
     * @returns TCP connection string using OmniProtocol port (e.g., "tcp://localhost:53551")
     *
     * Port derivation: peer's HTTP port + 1 (same logic as server's detectDefaultPort)
     */
    protected httpToTcpConnectionString(httpUrl: string): string {
        const url = new URL(httpUrl)
        const protocol = this.getTcpProtocol()
        const host = url.hostname
        // Derive OmniProtocol port from peer's HTTP port (HTTP port + 1)
        const peerHttpPort = parseInt(url.port) || 80
        const omniPort = peerHttpPort + 1

        return `${protocol}://${host}:${omniPort}`
    }

    /**
     * Get the TCP protocol to use (tcp or tls)
     * Override in subclasses for TLS support
     */
    protected getTcpProtocol(): string {
        // REVIEW: Check TLS configuration
        const tlsEnabled = process.env.OMNI_TLS_ENABLED === "true"
        return tlsEnabled ? "tls" : "tcp"
    }

    /**
     * Get the OmniProtocol port
     * Uses same logic as server: OMNI_PORT env var, or HTTP port + 1
     */
    protected getOmniPort(): string {
        if (process.env.OMNI_PORT) {
            return process.env.OMNI_PORT
        }
        // Match server's detectDefaultPort() logic: HTTP port + 1
        const httpPort = parseInt(process.env.NODE_PORT || process.env.PORT || "3000")
        return String(httpPort + 1)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Key Management
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get node's private key for signing
     */
    protected getPrivateKey(): Buffer | null {
        return getNodePrivateKey()
    }

    /**
     * Get node's public key for identity
     */
    protected getPublicKey(): Buffer | null {
        return getNodePublicKey()
    }

    /**
     * Check if node keys are available for authenticated requests
     */
    protected hasKeys(): boolean {
        return this.getPrivateKey() !== null && this.getPublicKey() !== null
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Connection Pool Access
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get the underlying connection pool for direct access
     */
    protected getConnectionPool(): ConnectionPool {
        return this.connectionPool
    }

    /**
     * Get connection pool statistics
     */
    getPoolStats(): {
        totalConnections: number
        activeConnections: number
        idleConnections: number
    } {
        // REVIEW: Add stats method to ConnectionPool if needed
        return {
            totalConnections: 0,
            activeConnections: 0,
            idleConnections: 0,
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Fatal Error Handling
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Check if OMNI_FATAL mode is enabled
     */
    protected isFatalMode(): boolean {
        return process.env.OMNI_FATAL === "true"
    }

    /**
     * Handle an error in fatal mode - exits if OMNI_FATAL=true
     * Call this in catch blocks before falling back to HTTP
     *
     * @param error The error that occurred
     * @param context Additional context for the error message
     * @returns true if error was fatal (will exit), false otherwise
     */
    protected handleFatalError(error: unknown, context: string): boolean {
        if (!this.isFatalMode()) {
            return false
        }

        // Format error message
        const errorMessage = error instanceof Error ? error.message : String(error)
        const errorStack = error instanceof Error ? error.stack : undefined

        log.error(`[OmniProtocol] OMNI_FATAL: ${context}`)
        log.error(`[OmniProtocol] Error: ${errorMessage}`)
        if (errorStack) {
            log.error(`[OmniProtocol] Stack: ${errorStack}`)
        }

        // If it's already an OmniProtocolError, it should have already exited
        // This handles non-OmniProtocolError cases (like plain Error("Connection closed"))
        if (!(error instanceof OmniProtocolError)) {
            log.error("[OmniProtocol] OMNI_FATAL: Exiting due to non-OmniProtocolError")
            process.exit(1)
        }

        return true
    }
}

