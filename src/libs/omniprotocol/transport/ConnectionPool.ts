// REVIEW: ConnectionPool - Manages pool of bidirectional TCP connections (both inbound and outbound)
import { Socket } from "net"
import { EventEmitter } from "events"
import { PeerConnection } from "./PeerConnection"
import {
    ConnectionState,
    ConnectionStateUtils,
    type ConnectionOptions,
    type PoolConfig,
    type PoolStats,
    type ConnectionInfo,
    type ConnectionOrigin,
} from "./types"
import { PoolCapacityError } from "../types/errors"
import log from "@/utilities/logger"
import { RateLimiter } from "../ratelimit"
import { PeerManager } from "@/libs/peer"
import { DEFAULT_OMNIPROTOCOL_CONFIG } from "../types/config"

/**
 * ConnectionPool manages bidirectional TCP connections to multiple peer nodes
 *
 * Unified connection management for both:
 * - OUTBOUND connections: We initiate TCP connect to remote peer via acquire()
 * - INBOUND connections: Remote peer connects to us via handleInboundSocket()
 *
 * Features:
 * - Per-peer connection pooling (default: max connections per peer configurable)
 * - Global connection limit enforcement
 * - Lazy connection creation for outbound (create on first use)
 * - Automatic inbound registration after authentication
 * - Automatic idle connection cleanup
 * - Connection reuse for efficiency (prefers newest connection)
 * - Health monitoring and statistics
 *
 * Connection lifecycle:
 * OUTBOUND:
 *   1. acquire() → get or create connection
 *   2. send() → use connection for request-response
 *   3. Automatic idle cleanup after timeout
 *
 * INBOUND:
 *   1. handleInboundSocket() → create PeerConnection with pending identity
 *   2. On "authenticated" event → re-register under real peer identity
 *   3. Connection now usable for bidirectional messaging
 *   4. Automatic idle cleanup after timeout
 */
export class ConnectionPool extends EventEmitter {
    private static instance: ConnectionPool | null = null
    private connections: Map<string, PeerConnection[]> = new Map()
    private pendingConnections: Map<string, PeerConnection> = new Map() // Temp tracking before auth
    private config: PoolConfig
    private cleanupTimer: NodeJS.Timeout | null = null
    public rateLimiter?: RateLimiter

    constructor(config: Partial<PoolConfig> = {}, rateLimiter?: RateLimiter) {
        super()
        this.config = {
            maxTotalConnections: config.maxTotalConnections ?? 100,
            maxConnectionsPerPeer: config.maxConnectionsPerPeer ?? 1,
            idleTimeout: config.idleTimeout ?? 10 * 60 * 1000, // 10 minutes
            connectTimeout: config.connectTimeout ?? 5000, // 5 seconds
            authTimeout: config.authTimeout ?? 5000, // 5 seconds
        }
        this.rateLimiter = rateLimiter

        // Start periodic cleanup of idle/dead connections
        this.startCleanupTimer()
    }

    /**
     * Handle an inbound socket connection from OmniProtocolServer
     *
     * Creates a PeerConnection in inbound mode with temporary identity.
     * Once authenticated, the connection is re-registered under the real peer identity.
     *
     * @param socket Incoming TCP socket
     * @returns Created PeerConnection (in PENDING_AUTH state)
     */
    handleInboundSocket(socket: Socket): PeerConnection {
        const remoteAddress = socket.remoteAddress || "unknown"
        const remotePort = socket.remotePort || 0

        log.only(
            `==== DEBUG: Handling inbound socket from ${remoteAddress}:${remotePort} ====`,
        )
        log.only(`Confirmed Connection count: ${this.connections.size}`)
        log.only(`Pending Connection count: ${this.pendingConnections.size}`)

        // Create temporary ID for tracking before authentication
        const tempId = `pending:${remoteAddress}:${remotePort}:${Date.now()}`

        // Create PeerConnection in inbound mode
        const connection = new PeerConnection(
            tempId,
            "", // No connection string for inbound
            socket,
            this.rateLimiter,
        )

        // Track in pending connections
        this.pendingConnections.set(tempId, connection)
        log.only(`Added pending connection: ${tempId}`)
        log.only(`Pending connections: ${this.pendingConnections.size}`)

        // Register rate limiter connection
        if (this.rateLimiter) {
            this.rateLimiter.addConnection(remoteAddress)
        }

        // Listen for authentication to re-register under real identity
        connection.on("authenticated", (peerIdentity: string) => {
            log.only(`Authenticated connection: ${peerIdentity}`)
            this.registerAuthenticatedConnection(
                connection,
                peerIdentity,
                tempId,
            )
        })

        // Listen for connection close to cleanup
        connection.on("close", () => {
            this.handleConnectionClose(connection, tempId)
        })

        // Listen for errors
        connection.on("error", (error: Error) => {
            log.error(`[ConnectionPool] Connection ${tempId} error: ${error}`)
            this.emit("connection_error", tempId, error)
        })

        log.only(
            `[ConnectionPool] Accepted inbound connection from ${remoteAddress}:${remotePort} 🔴`,
        )
        this.emit("connection_accepted", remoteAddress)

        return connection
    }

    /**
     * Re-register an inbound connection under its authenticated peer identity
     */
    private registerAuthenticatedConnection(
        connection: PeerConnection,
        peerIdentity: string,
        tempId: string,
    ): void {
        log.only(
            `==== DEBUG: Registering authenticated connection for ${connection.socket.remotePort} ====`,
        )
        // Remove from pending tracking
        this.pendingConnections.delete(tempId)

        // Get existing connections for this peer
        const existing = this.connections.get(peerIdentity) || []

        // Check if we're at max connections for this peer
        const usableConnections = existing.filter(c =>
            ConnectionStateUtils.isUsable(c.getState()),
        )
        log.only(`Usable connections: ${usableConnections.length}`)
        log.only(
            `Max connections per peer: ${this.config.maxConnectionsPerPeer}`,
        )
        if (usableConnections.length >= this.config.maxConnectionsPerPeer) {
            // INFO: Reject the connection
            log.error(
                `[ConnectionPool] Max connections per peer reached for ${peerIdentity}`,
            )
            log.error(
                `[ConnectionPool] Rejecting connection ${connection.socketId} for ${peerIdentity}`,
            )
            connection.close().catch(() => {})
            this.emit("connection_rejected", peerIdentity, "max_connections")
            return
        }

        // Add new connection
        existing.push(connection)
        this.connections.set(peerIdentity, existing)

        log.only(
            `[ConnectionPool] Registered authenticated inbound connection for ${peerIdentity}`,
        )
        log.only(`Connection count: ${this.connections.size}`)
        this.emit("peer_authenticated", peerIdentity, connection)
    }

    /**
     * Handle connection close event
     */
    private handleConnectionClose(
        connection: PeerConnection,
        tempId: string,
    ): void {
        const peerIdentity = connection.peerIdentity

        // Remove from pending if still there
        this.pendingConnections.delete(tempId)

        // Remove from main connections map
        const peerConnections = this.connections.get(peerIdentity)
        if (peerConnections) {
            const index = peerConnections.indexOf(connection)
            if (index !== -1) {
                peerConnections.splice(index, 1)
            }
            if (peerConnections.length === 0) {
                this.connections.delete(peerIdentity)
            }
        }

        // Notify rate limiter
        if (this.rateLimiter && connection.socket?.remoteAddress) {
            this.rateLimiter.removeConnection(connection.socket.remoteAddress)
        }

        this.emit("connection_closed", peerIdentity)
    }

    /**
     * Acquire a connection to a peer (create outbound if needed)
     *
     * Looks for existing usable connections first (prefers newest).
     * Creates new outbound connection if none available.
     *
     * @param peerIdentity Peer public key or identifier
     * @param connectionString Connection string (e.g., "tcp://ip:port")
     * @param options Connection options
     * @returns Promise resolving to ready PeerConnection
     */
    async acquire(
        peerIdentity: string,
        connectionString: string,
        options: ConnectionOptions = {},
    ): Promise<PeerConnection | null> {
        // Try to reuse existing usable connection (prefers newest)
        const peer = PeerManager.getInstance().getPeer(peerIdentity)
        log.only(
            `==== DEBUG: Acquiring connection to ${
                peer ? peer.connection.string : "Unknown peer"
            } ====`,
        )
        log.only(`Connection string: ${connectionString}`)
        log.only(`Options: ${JSON.stringify(options)}`)

        const totalConnections = this.getTotalConnectionCount()
        log.only(`Total connections: ${totalConnections}`)
        log.only(`Total pending connections: ${this.pendingConnections.size}`)

        const existing = this.findUsableConnection(peerIdentity)
        log.only(`Existing connection: ${existing ? "Found" : "Not found"}`)
        if (existing) {
            log.only("Returning existing connection")
            log.only(`Socket ID: ${existing.socketId}`)
            return existing
        }

        // Check pool capacity limits
        if (totalConnections >= this.config.maxTotalConnections) {
            throw new PoolCapacityError(
                `Pool at capacity: ${totalConnections}/${this.config.maxTotalConnections} connections`,
            )
        }

        // Check per-peer limits
        const peerConnections = this.connections.get(peerIdentity) || []
        const usableCount = peerConnections.filter(c =>
            ConnectionStateUtils.isUsable(c.getState()),
        ).length
        log.only(`Peer connections: ${usableCount}`)
        log.only(
            `Max connections per peer: ${this.config.maxConnectionsPerPeer}`,
        )
        if (usableCount >= this.config.maxConnectionsPerPeer) {
            throw new PoolCapacityError(
                `Max connections to peer ${peerIdentity}: ${usableCount}/${this.config.maxConnectionsPerPeer}`,
            )
        }

        // Create new outbound connection
        const connection = new PeerConnection(peerIdentity, connectionString)

        // Add to pool before connecting (allows tracking)
        peerConnections.push(connection)
        this.connections.set(peerIdentity, peerConnections)

        // Listen for close
        connection.on("close", () => {
            this.handleConnectionClose(connection, "")
        })

        const removeConnectionFromPool = (connection: PeerConnection): void => {
            const index = peerConnections.indexOf(connection)
            if (index !== -1) {
                peerConnections.splice(index, 1)
            }
            if (peerConnections.length === 0) {
                this.connections.delete(peerIdentity)
            }
        }

        try {
            connection.on("error", (error: Error) => {
                log.error("Connection error in connection handler")
                // throw error
                removeConnectionFromPool(connection)
                return null
            })

            await connection.connect({
                timeout: options.timeout ?? this.config.connectTimeout,
                retries: options.retries,
            })

            log.debug(
                `[ConnectionPool] Created outbound connection to ${peerIdentity}`,
            )
            return connection
        } catch (error) {
            log.error("Error in acquire")
            // Remove failed connection from pool
            removeConnectionFromPool(connection)
            throw error
        }
    }

    /**
     * Release a connection back to the pool
     * Does not close the connection - just marks it available for reuse
     */
    release(connection: PeerConnection): void {
        // Connection stays in pool and will be reused or cleaned up by timer
        // Could add activity tracking here if needed
    }

    /**
     * Send a request to a peer (acquire connection, send, release)
     * Convenience method that handles connection lifecycle
     * @param peerIdentity Peer public key or identifier
     * @param connectionString Connection string (e.g., "tcp://ip:port")
     * @param opcode OmniProtocol opcode
     * @param payload Request payload
     * @param options Request options
     * @returns Promise resolving to response payload
     */
    async send(
        peerIdentity: string,
        connectionString: string,
        opcode: number,
        payload: Buffer,
        options: ConnectionOptions = {},
    ): Promise<Buffer> {
        const peer = PeerManager.getInstance().getPeer(peerIdentity)
        log.only(
            `==== DEBUG: Sending request to ${
                peer ? peer.connection.string : "Unknown peer"
            } ====`,
        )
        let connection: PeerConnection | null = null

        try {
            connection = await this.acquire(
                peerIdentity,
                connectionString,
                options,
            )
            log.only(`Resolved connection ID: ${connection.socketId}`)

            if (!connection) {
                throw new Error("Connection not found")
            }

            const response = await connection.send(opcode, payload, options)
            this.release(connection)
            return response
        } catch (error) {
            log.error(
                `[ConnectionPool] Error sending request to ${peerIdentity}: ${error}`,
            )
            // On error, close the connection and remove from pool
            if (connection) {
                await this.closeConnection(connection)
            }

            throw error
        }
    }

    /**
     * Send an authenticated request to a peer
     * Convenience method that handles connection lifecycle with authentication
     * @param peerIdentity Peer public key or identifier
     * @param connectionString Connection string (e.g., "tcp://ip:port")
     * @param opcode OmniProtocol opcode
     * @param payload Request payload
     * @param privateKey Ed25519 private key for signing
     * @param publicKey Ed25519 public key for identity
     * @param options Request options
     * @returns Promise resolving to response payload
     */
    async sendAuthenticated(
        peerIdentity: string,
        connectionString: string,
        opcode: number,
        payload: Buffer,
        privateKey: Buffer,
        publicKey: Buffer,
        options: ConnectionOptions = {},
    ): Promise<Buffer> {
        let connection: PeerConnection | null = null

        try {
            connection = await this.acquire(
                peerIdentity,
                connectionString,
                options,
            )

            if (!connection) {
                throw new Error("Connection not found")
            }

            const response = await connection.sendAuthenticated(
                opcode,
                payload,
                privateKey,
                publicKey,
                options,
            )
            this.release(connection)
            return response
        } catch (error) {
            // On error, close the connection and remove from pool
            if (connection) {
                await this.closeConnection(connection)
            }

            throw error
        }
    }

    /**
     * Get pool statistics for monitoring
     */
    getStats(): PoolStats & {
        pendingAuth: number
        inbound: number
        outbound: number
    } {
        let totalConnections = 0
        let activeConnections = 0
        let idleConnections = 0
        let connectingConnections = 0
        let deadConnections = 0
        let inbound = 0
        let outbound = 0

        for (const peerConnections of this.connections.values()) {
            for (const connection of peerConnections) {
                totalConnections++

                const state = connection.getState()
                // Use numeric comparisons for state categorization
                if (state === ConnectionState.READY) {
                    activeConnections++
                } else if (ConnectionStateUtils.isUsable(state)) {
                    // AUTHENTICATED or IDLE (both value 10)
                    idleConnections++
                } else if (
                    state > ConnectionState.UNINITIALIZED &&
                    state < ConnectionState.AUTHENTICATED
                ) {
                    // CONNECTING, CONNECTED, PENDING_AUTH (1-9)
                    connectingConnections++
                } else if (ConnectionStateUtils.isTerminal(state)) {
                    deadConnections++
                }

                if (connection.origin === "inbound") {
                    inbound++
                } else {
                    outbound++
                }
            }
        }

        return {
            totalConnections: totalConnections + this.pendingConnections.size,
            activeConnections,
            idleConnections,
            connectingConnections,
            deadConnections,
            pendingAuth: this.pendingConnections.size,
            inbound,
            outbound,
        }
    }

    /**
     * Get connection information for a specific peer
     */
    getConnectionInfo(
        peerIdentity: string,
    ): (ConnectionInfo & { origin: ConnectionOrigin })[] {
        const peerConnections = this.connections.get(peerIdentity) || []
        return peerConnections.map(conn => conn.getInfo())
    }

    /**
     * Get connection information for all peers
     */
    getAllConnectionInfo(): Map<
        string,
        (ConnectionInfo & { origin: ConnectionOrigin })[]
    > {
        const result = new Map<
            string,
            (ConnectionInfo & { origin: ConnectionOrigin })[]
        >()

        for (const [peerIdentity, connections] of this.connections.entries()) {
            result.set(
                peerIdentity,
                connections.map(conn => conn.getInfo()),
            )
        }

        return result
    }

    /**
     * Get connection count
     */
    getConnectionCount(): number {
        return this.getTotalConnectionCount() + this.pendingConnections.size
    }

    /**
     * Get all connections for a specific peer
     * Used for cross-connection response routing
     */
    getConnections(peerIdentity: string): PeerConnection[] {
        return this.connections.get(peerIdentity) ?? []
    }

    /**
     * Get connection count by IP address
     */
    getConnectionCountByIp(ipAddress: string): number {
        let count = 0

        for (const peerConnections of this.connections.values()) {
            for (const conn of peerConnections) {
                log.only(
                    "Connection remote address: " + conn.socket?.remoteAddress,
                )
                if (conn.socket?.remoteAddress === ipAddress) {
                    count++
                }
            }
        }

        for (const conn of this.pendingConnections.values()) {
            if (conn.socket?.remoteAddress === ipAddress) {
                log.only(
                    "Pending connection remote address: " +
                        conn.socket?.remoteAddress,
                )
                count++
            }
        }

        return count
    }

    /**
     * Gracefully shutdown the pool
     */
    async shutdown(): Promise<void> {
        // Stop cleanup timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }

        // Close all connections in parallel
        const closePromises: Promise<void>[] = []

        for (const peerConnections of this.connections.values()) {
            for (const connection of peerConnections) {
                closePromises.push(connection.close())
            }
        }

        for (const connection of this.pendingConnections.values()) {
            closePromises.push(connection.close())
        }

        await Promise.allSettled(closePromises)

        // Clear all connections
        this.connections.clear()
        this.pendingConnections.clear()

        log.info("[ConnectionPool] Shutdown complete")
    }

    /**
     * Find an existing usable connection for a peer (prefers newest)
     */
    private findUsableConnection(peerIdentity: string): PeerConnection | null {
        const peerConnections = this.connections.get(peerIdentity)
        if (!peerConnections || peerConnections.length === 0) {
            return null
        }

        // Filter to usable connections
        const usable = peerConnections.filter(conn =>
            ConnectionStateUtils.isUsable(conn.getState()),
        )

        if (usable.length === 0) {
            return null
        }

        // Prefer newest (most recent lastActivity)
        return usable.reduce((newest, conn) =>
            conn.getInfo().lastActivity > newest.getInfo().lastActivity
                ? conn
                : newest,
        )
    }

    /**
     * Find the oldest connection in a list
     */
    private findOldestConnection(
        connections: PeerConnection[],
    ): PeerConnection | null {
        if (connections.length === 0) return null

        return connections.reduce((oldest, conn) =>
            conn.getInfo().lastActivity < oldest.getInfo().lastActivity
                ? conn
                : oldest,
        )
    }

    /**
     * Get total connection count across all peers (excluding pending)
     */
    public getTotalConnectionCount(): number {
        let count = 0
        for (const peerConnections of this.connections.values()) {
            count += peerConnections.length
        }
        return count
    }

    /**
     * Close a specific connection and remove from pool
     */
    private async closeConnection(connection: PeerConnection): Promise<void> {
        const info = connection.getInfo()
        const peerConnections = this.connections.get(info.peerIdentity)

        if (peerConnections) {
            const index = peerConnections.indexOf(connection)
            if (index !== -1) {
                peerConnections.splice(index, 1)
            }

            if (peerConnections.length === 0) {
                this.connections.delete(info.peerIdentity)
            }
        }

        await connection.close()
    }

    /**
     * Periodic cleanup of idle and dead connections
     */
    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanupDeadConnections()
        }, 60 * 1000) // Run every minute
    }

    /**
     * Remove dead and idle connections from pool
     */
    private async cleanupDeadConnections(): Promise<void> {
        const now = Date.now()
        const connectionsToClose: PeerConnection[] = []

        // Clean up authenticated connections
        for (const [
            peerIdentity,
            peerConnections,
        ] of this.connections.entries()) {
            const remainingConnections = peerConnections.filter(connection => {
                const state = connection.getState()
                const info = connection.getInfo()

                // Remove terminal connections
                if (ConnectionStateUtils.isTerminal(state)) {
                    connectionsToClose.push(connection)
                    return false
                }

                // Close IDLE connections with no in-flight requests after timeout
                if (
                    state === ConnectionState.IDLE &&
                    info.inFlightCount === 0
                ) {
                    const idleTime = now - info.lastActivity
                    if (idleTime > this.config.idleTimeout) {
                        connectionsToClose.push(connection)
                        return false
                    }
                }

                return true
            })

            // Update or remove peer entry
            if (remainingConnections.length === 0) {
                this.connections.delete(peerIdentity)
            } else {
                this.connections.set(peerIdentity, remainingConnections)
            }
        }

        // Clean up pending connections that timed out
        for (const [tempId, connection] of this.pendingConnections.entries()) {
            const state = connection.getState()
            const createdAt = connection.getCreatedAt()

            // Remove if terminal or auth timed out
            if (
                ConnectionStateUtils.isTerminal(state) ||
                (state === ConnectionState.PENDING_AUTH &&
                    now - createdAt > this.config.authTimeout)
            ) {
                this.pendingConnections.delete(tempId)
                connectionsToClose.push(connection)
            }
        }

        // Close removed connections
        for (const connection of connectionsToClose) {
            try {
                await connection.close()
            } catch {
                // Ignore errors during cleanup
            }
        }

        if (connectionsToClose.length > 0) {
            log.debug(
                `[ConnectionPool] Cleaned up ${connectionsToClose.length} idle/dead connections`,
            )
        }
    }

    static getInstance(rateLimiter?: RateLimiter): ConnectionPool {
        if (!this.instance && rateLimiter) {
            this.instance = new ConnectionPool(
                structuredClone(DEFAULT_OMNIPROTOCOL_CONFIG.pool),
                rateLimiter,
            )
        }

        if (!this.instance && !rateLimiter) {
            log.error("Connection Pool not initialized")
            process.exit(1)
        }

        return this.instance
    }
}
