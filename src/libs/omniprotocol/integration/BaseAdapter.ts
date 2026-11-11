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
import { RateLimiter } from "../ratelimit"
import { MAX_HTTP_FALLBACK_COOLDOWN_MS } from "../constants"

export interface BaseAdapterOptions {
    config?: OmniProtocolConfig
}

/** Where a peer said, in a verified hello reply, its Omni server listens. */
interface OmniEndpoint {
    /** Origin of the HTTP URL the advertisement was verified for. */
    origin: string
    port: number
}

function originOf(httpUrl: string): string | null {
    try {
        return new URL(httpUrl).origin
    } catch {
        return null
    }
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
    /** Peers answered over HTTP only, keyed by identity, until the given time. */
    private readonly httpOnlyUntil = new Map<string, number>()
    private readonly omniEndpoints = new Map<string, OmniEndpoint>()
    /** Omni failures in a row per peer, since its last Omni answer. */
    private readonly omniFailures = new Map<string, number>()

    constructor(options: BaseAdapterOptions = {}) {
        this.config = cloneConfig(options.config ?? DEFAULT_OMNIPROTOCOL_CONFIG)

        // Initialize ConnectionPool with RateLimiter
        this.connectionPool = ConnectionPool.getInstance(
            RateLimiter.getInstance(),
        )
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
     * Check if OmniProtocol should be used for a peer based on migration mode.
     * A peer whose OmniProtocol call failed stays on HTTP for the cooldown,
     * so a closed Omni port costs one connect timeout, not one per call.
     */
    shouldUseOmni(peerIdentity: string, httpUrl?: string): boolean {
        const { mode, omniPeers } = this.config.migration

        if (this.isHttpOnly(peerIdentity)) {
            return false
        }

        switch (mode) {
            case "HTTP_ONLY":
                return false
            case "OMNI_PREFERRED":
                if (!omniPeers.has(peerIdentity)) {
                    return false
                }
                // The port was advertised for one address; once the peer
                // moves, it says nothing about the new host.
                return (
                    httpUrl === undefined ||
                    this.endpointFor(peerIdentity, httpUrl) !== null ||
                    !this.omniEndpoints.has(peerIdentity)
                )
            case "OMNI_ONLY":
                return true
            default:
                return false
        }
    }

    /**
     * Whether the peer is inside its HTTP-only cooldown
     */
    isHttpOnly(peerIdentity: string): boolean {
        const until = this.httpOnlyUntil.get(peerIdentity)
        if (until === undefined) {
            return false
        }
        if (Date.now() >= until) {
            this.httpOnlyUntil.delete(peerIdentity)
            return false
        }
        return true
    }

    /**
     * Mark a peer as OmniProtocol-capable
     */
    markOmniPeer(peerIdentity: string): void {
        this.httpOnlyUntil.delete(peerIdentity)
        this.config.migration.omniPeers.add(peerIdentity)
    }

    /**
     * Record the Omni port a peer advertised in a hello reply that proved it
     * serves httpUrl. Calls to it then dial that host at that port.
     */
    recordOmniEndpoint(peerIdentity: string, httpUrl: string, port: number) {
        const origin = originOf(httpUrl)
        if (!origin || !Number.isInteger(port) || port < 1 || port > 65535) {
            this.forgetOmniPeer(peerIdentity)
            return
        }
        const known = this.omniEndpoints.get(peerIdentity)
        this.omniEndpoints.set(peerIdentity, { origin, port })
        if (known?.origin === origin && known.port === port) {
            // Hellos repeat: the same advert must not cut a backoff short.
            this.config.migration.omniPeers.add(peerIdentity)
            return
        }
        this.omniFailures.delete(peerIdentity)
        this.markOmniPeer(peerIdentity)
    }

    /** The peer no longer advertises an Omni server: back to HTTP. */
    forgetOmniPeer(peerIdentity: string): void {
        this.omniEndpoints.delete(peerIdentity)
        this.config.migration.omniPeers.delete(peerIdentity)
    }

    private endpointFor(
        peerIdentity: string,
        httpUrl: string,
    ): OmniEndpoint | null {
        const endpoint = this.omniEndpoints.get(peerIdentity)
        if (!endpoint || endpoint.origin !== originOf(httpUrl)) {
            return null
        }
        return endpoint
    }

    /**
     * Mark a peer as HTTP-only for the cooldown (e.g., after OmniProtocol failure).
     * Its Omni capability is kept, so it is retried over Omni afterwards.
     */
    markHttpPeer(peerIdentity: string): void {
        // An advertised port that stays unreachable costs a connect timeout
        // per cooldown; doubling keeps that cost from recurring every minute.
        const failures = (this.omniFailures.get(peerIdentity) ?? 0) + 1
        this.omniFailures.set(peerIdentity, failures)
        const cooldown = Math.min(
            this.config.migration.httpFallbackCooldown * 2 ** (failures - 1),
            MAX_HTTP_FALLBACK_COOLDOWN_MS,
        )
        this.httpOnlyUntil.set(peerIdentity, Date.now() + cooldown)
    }

    /** The peer answered over Omni: the next failure starts a fresh backoff. */
    noteOmniAnswer(peerIdentity: string): void {
        this.omniFailures.delete(peerIdentity)
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
     * TCP connection string for a peer: the port it advertised for this
     * address, else the HTTP port + 1 convention (OMNI_ONLY only).
     */
    protected omniConnectionString(peerIdentity: string, httpUrl: string) {
        const endpoint = this.endpointFor(peerIdentity, httpUrl)
        if (!endpoint) {
            return this.httpToTcpConnectionString(httpUrl)
        }
        // Only plain-TCP servers advertise a port
        const host = new URL(httpUrl).hostname
        return `tcp://${host}:${endpoint.port}`
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
        const httpPort = parseInt(
            process.env.NODE_PORT || process.env.PORT || "3000",
        )
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

    // /**
    //  * Get the underlying connection pool for direct access
    //  */
    // protected getConnectionPool(): ConnectionPool {
    //     return this.connectionPool
    // }

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
        const errorMessage =
            error instanceof Error ? error.message : String(error)
        const errorStack = error instanceof Error ? error.stack : undefined

        log.error(`[OmniProtocol] OMNI_FATAL: ${context}`)
        log.error(`[OmniProtocol] Error: ${errorMessage}`)
        if (errorStack) {
            log.error(`[OmniProtocol] Stack: ${errorStack}`)
        }

        // If it's already an OmniProtocolError, it should have already exited
        // This handles non-OmniProtocolError cases (like plain Error("Connection closed"))
        if (!(error instanceof OmniProtocolError)) {
            log.error(
                "[OmniProtocol] OMNI_FATAL: Exiting due to non-OmniProtocolError",
            )
            process.exit(1)
        }

        return true
    }
}
