import { Socket } from "net"
import { InboundConnection } from "./InboundConnection"
import { EventEmitter } from "events"
import { RateLimiter } from "../ratelimit"

export interface ConnectionManagerConfig {
    maxConnections: number
    connectionTimeout: number
    authTimeout: number
    rateLimiter?: RateLimiter
}

/**
 * ServerConnectionManager manages lifecycle of all inbound connections
 */
export class ServerConnectionManager extends EventEmitter {
    private connections: Map<string, InboundConnection> = new Map()
    private config: ConnectionManagerConfig
    private cleanupTimer: NodeJS.Timeout | null = null
    private rateLimiter?: RateLimiter

    constructor(config: ConnectionManagerConfig) {
        super()
        this.config = config
        this.rateLimiter = config.rateLimiter
        this.startCleanupTimer()
    }

    /**
     * Handle new incoming socket connection
     */
    handleConnection(socket: Socket): void {
        const connectionId = this.generateConnectionId(socket)

        // Create inbound connection wrapper
        const connection = new InboundConnection(socket, connectionId, {
            authTimeout: this.config.authTimeout,
            connectionTimeout: this.config.connectionTimeout,
            rateLimiter: this.rateLimiter,
        })

        // Track connection
        this.connections.set(connectionId, connection)

        // Handle connection lifecycle events
        connection.on("authenticated", (peerIdentity: string) => {
            this.emit("peer_authenticated", peerIdentity, connectionId)
        })

        connection.on("error", (error: Error) => {
            this.emit("connection_error", connectionId, error)
            this.removeConnection(connectionId, socket)
        })

        connection.on("close", () => {
            this.removeConnection(connectionId, socket)
        })

        // Start connection (will wait for hello_peer)
        connection.start()
    }

    /**
     * Close all connections
     */
    async closeAll(): Promise<void> {
        console.log(`[ServerConnectionManager] Closing ${this.connections.size} connections...`)

        const closePromises = Array.from(this.connections.values()).map(conn =>
            conn.close()
        )

        await Promise.allSettled(closePromises)

        this.connections.clear()

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }
    }

    /**
     * Get connection count
     */
    getConnectionCount(): number {
        return this.connections.size
    }

    /**
     * Get statistics
     */
    getStats() {
        let authenticated = 0
        let pending = 0
        let idle = 0

        for (const conn of this.connections.values()) {
            const state = conn.getState()
            if (state === "AUTHENTICATED") authenticated++
            else if (state === "PENDING_AUTH") pending++
            else if (state === "IDLE") idle++
        }

        return {
            total: this.connections.size,
            authenticated,
            pending,
            idle,
        }
    }

    /**
     * Remove connection from tracking
     */
    private removeConnection(connectionId: string, socket?: Socket): void {
        const removed = this.connections.delete(connectionId)
        if (removed) {
            // Notify rate limiter to decrement connection count
            if (socket && socket.remoteAddress && this.rateLimiter) {
                this.rateLimiter.removeConnection(socket.remoteAddress)
            }
            this.emit("connection_removed", connectionId)
        }
    }

    /**
     * Generate unique connection identifier
     */
    private generateConnectionId(socket: Socket): string {
        return `${socket.remoteAddress}:${socket.remotePort}:${Date.now()}`
    }

    /**
     * Periodic cleanup of dead/idle connections
     */
    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            const now = Date.now()
            const toRemove: string[] = []

            for (const [id, conn] of this.connections) {
                const state = conn.getState()
                const lastActivity = conn.getLastActivity()

                // Remove closed connections
                if (state === "CLOSED") {
                    toRemove.push(id)
                    continue
                }

                // Remove idle connections
                if (state === "IDLE" && now - lastActivity > this.config.connectionTimeout) {
                    toRemove.push(id)
                    conn.close()
                    continue
                }

                // Remove pending auth connections that timed out
                if (
                    state === "PENDING_AUTH" &&
                    now - conn.getCreatedAt() > this.config.authTimeout
                ) {
                    toRemove.push(id)
                    conn.close()
                    continue
                }
            }

            for (const id of toRemove) {
                this.removeConnection(id)
            }

            if (toRemove.length > 0) {
                console.log(
                    `[ServerConnectionManager] Cleaned up ${toRemove.length} connections`
                )
            }
        }, 60000) // Run every minute
    }
}
