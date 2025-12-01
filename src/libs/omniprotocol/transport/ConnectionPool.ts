// REVIEW: ConnectionPool - Manages pool of persistent TCP connections to peer nodes
import { PeerConnection } from "./PeerConnection"
import type {
    ConnectionOptions,
    PoolConfig,
    PoolStats,
    ConnectionInfo,
    ConnectionState,
} from "./types"
import { PoolCapacityError } from "../types/errors"

/**
 * ConnectionPool manages persistent TCP connections to multiple peer nodes
 *
 * Features:
 * - Per-peer connection pooling (default: 1 connection per peer)
 * - Global connection limit enforcement
 * - Lazy connection creation (create on first use)
 * - Automatic idle connection cleanup
 * - Connection reuse for efficiency
 * - Health monitoring and statistics
 *
 * Connection lifecycle:
 * 1. acquire() → get or create connection
 * 2. send() → use connection for request-response
 * 3. Automatic idle cleanup after timeout
 * 4. release() / shutdown() → graceful cleanup
 */
export class ConnectionPool {
    private connections: Map<string, PeerConnection[]> = new Map()
    private config: PoolConfig
    private cleanupTimer: NodeJS.Timeout | null = null

    constructor(config: Partial<PoolConfig> = {}) {
        this.config = {
            maxTotalConnections: config.maxTotalConnections ?? 100,
            maxConnectionsPerPeer: config.maxConnectionsPerPeer ?? 1,
            idleTimeout: config.idleTimeout ?? 10 * 60 * 1000, // 10 minutes
            connectTimeout: config.connectTimeout ?? 5000, // 5 seconds
            authTimeout: config.authTimeout ?? 5000, // 5 seconds
        }

        // Start periodic cleanup of idle/dead connections
        this.startCleanupTimer()
    }

    /**
     * Acquire a connection to a peer (create if needed)
     * @param peerIdentity Peer public key or identifier
     * @param connectionString Connection string (e.g., "tcp://ip:port")
     * @param options Connection options
     * @returns Promise resolving to ready PeerConnection
     */
    async acquire(
        peerIdentity: string,
        connectionString: string,
        options: ConnectionOptions = {},
    ): Promise<PeerConnection> {
        // Try to reuse existing READY connection
        const existing = this.findReadyConnection(peerIdentity)
        if (existing) {
            return existing
        }

        // Check pool capacity limits
        const totalConnections = this.getTotalConnectionCount()
        if (totalConnections >= this.config.maxTotalConnections) {
            throw new PoolCapacityError(
                `Pool at capacity: ${totalConnections}/${this.config.maxTotalConnections} connections`,
            )
        }

        const peerConnections = this.connections.get(peerIdentity) || []
        if (peerConnections.length >= this.config.maxConnectionsPerPeer) {
            throw new PoolCapacityError(
                `Max connections to peer ${peerIdentity}: ${peerConnections.length}/${this.config.maxConnectionsPerPeer}`,
            )
        }

        // Create new connection
        const connection = new PeerConnection(peerIdentity, connectionString)

        // Add to pool before connecting (allows tracking)
        peerConnections.push(connection)
        this.connections.set(peerIdentity, peerConnections)

        try {
            await connection.connect({
                timeout: options.timeout ?? this.config.connectTimeout,
                retries: options.retries,
            })

            return connection
        } catch (error) {
            // Remove failed connection from pool
            const index = peerConnections.indexOf(connection)
            if (index !== -1) {
                peerConnections.splice(index, 1)
            }
            if (peerConnections.length === 0) {
                this.connections.delete(peerIdentity)
            }

            throw error
        }
    }

    /**
     * Release a connection back to the pool
     * Does not close the connection - just marks it available for reuse
     * @param connection Connection to release
     */
    release(connection: PeerConnection): void {
        // Wave 8.1: Simple release - just keep connection in pool
        // Wave 8.2: Add connection tracking and reuse logic
        // For now, connection stays in pool and will be reused or cleaned up by timer
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
        const connection = await this.acquire(
            peerIdentity,
            connectionString,
            options,
        )

        try {
            const response = await connection.send(opcode, payload, options)
            this.release(connection)
            return response
        } catch (error) {
            // On error, close the connection and remove from pool
            await this.closeConnection(connection)
            throw error
        }
    }

    /**
     * Send an authenticated request to a peer (acquire connection, sign, send, release)
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
        const connection = await this.acquire(
            peerIdentity,
            connectionString,
            options,
        )

        try {
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
            await this.closeConnection(connection)
            throw error
        }
    }

    /**
     * Get pool statistics for monitoring
     * @returns Current pool statistics
     */
    getStats(): PoolStats {
        let totalConnections = 0
        let activeConnections = 0
        let idleConnections = 0
        let connectingConnections = 0
        let deadConnections = 0

        for (const peerConnections of this.connections.values()) {
            for (const connection of peerConnections) {
                totalConnections++

                const state = connection.getState()
                switch (state) {
                    case "READY":
                        activeConnections++
                        break
                    case "IDLE_PENDING":
                        idleConnections++
                        break
                    case "CONNECTING":
                    case "AUTHENTICATING":
                        connectingConnections++
                        break
                    case "ERROR":
                    case "CLOSED":
                    case "CLOSING":
                        deadConnections++
                        break
                }
            }
        }

        return {
            totalConnections,
            activeConnections,
            idleConnections,
            connectingConnections,
            deadConnections,
        }
    }

    /**
     * Get connection information for a specific peer
     * @param peerIdentity Peer public key or identifier
     * @returns Array of connection info for the peer
     */
    getConnectionInfo(peerIdentity: string): ConnectionInfo[] {
        const peerConnections = this.connections.get(peerIdentity) || []
        return peerConnections.map((conn) => conn.getInfo())
    }

    /**
     * Get connection information for all peers
     * @returns Map of peer identity to connection info arrays
     */
    getAllConnectionInfo(): Map<string, ConnectionInfo[]> {
        const result = new Map<string, ConnectionInfo[]>()

        for (const [peerIdentity, connections] of this.connections.entries()) {
            result.set(
                peerIdentity,
                connections.map((conn) => conn.getInfo()),
            )
        }

        return result
    }

    /**
     * Gracefully shutdown the pool
     * Closes all connections and stops cleanup timer
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

        await Promise.allSettled(closePromises)

        // Clear all connections
        this.connections.clear()
    }

    /**
     * Find an existing READY connection for a peer
     * @private
     */
    private findReadyConnection(
        peerIdentity: string,
    ): PeerConnection | null {
        const peerConnections = this.connections.get(peerIdentity)
        if (!peerConnections) {
            return null
        }

        // Find first READY connection
        return (
            peerConnections.find((conn) => conn.getState() === "READY") || null
        )
    }

    /**
     * Get total connection count across all peers
     * @private
     */
    private getTotalConnectionCount(): number {
        let count = 0
        for (const peerConnections of this.connections.values()) {
            count += peerConnections.length
        }
        return count
    }

    /**
     * Close a specific connection and remove from pool
     * @private
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
     * @private
     */
    private startCleanupTimer(): void {
        // Run cleanup every minute
        this.cleanupTimer = setInterval(() => {
            this.cleanupDeadConnections()
        }, 60 * 1000)
    }

    /**
     * Remove dead and idle connections from pool
     * @private
     */
    private async cleanupDeadConnections(): Promise<void> {
        const now = Date.now()
        const connectionsToClose: PeerConnection[] = []

        for (const [peerIdentity, peerConnections] of this.connections.entries()) {
            const remainingConnections = peerConnections.filter(
                (connection) => {
                    const state = connection.getState()
                    const info = connection.getInfo()

                    // Remove CLOSED or ERROR connections
                    if (state === "CLOSED" || state === "ERROR") {
                        connectionsToClose.push(connection)
                        return false
                    }

                    // Close IDLE_PENDING connections with no in-flight requests
                    if (state === "IDLE_PENDING" && info.inFlightCount === 0) {
                        const idleTime = now - info.lastActivity
                        if (idleTime > this.config.idleTimeout) {
                            connectionsToClose.push(connection)
                            return false
                        }
                    }

                    return true
                },
            )

            // Update or remove peer entry
            if (remainingConnections.length === 0) {
                this.connections.delete(peerIdentity)
            } else {
                this.connections.set(peerIdentity, remainingConnections)
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
            console.debug(
                `[ConnectionPool] Cleaned up ${connectionsToClose.length} idle/dead connections`,
            )
        }
    }
}
