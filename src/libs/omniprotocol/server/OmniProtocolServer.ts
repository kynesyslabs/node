import log from "src/utilities/logger"
import { Server as NetServer, Socket } from "net"
import { EventEmitter } from "events"
import { ConnectionPool } from "../transport/ConnectionPool"
import { RateLimiter, RateLimitConfig } from "../ratelimit"

export interface ServerConfig {
    host: string // Listen address (default: "0.0.0.0")
    port: number // Listen port (default: node.port + 1)
    maxConnections: number // Max concurrent connections (default: 1000)
    connectionTimeout: number // Idle connection timeout (default: 10 min)
    authTimeout: number // Auth handshake timeout (default: 5 sec)
    backlog: number // TCP backlog queue (default: 511)
    enableKeepalive: boolean // TCP keepalive (default: true)
    keepaliveInitialDelay: number // Keepalive delay (default: 60 sec)
    rateLimit?: Partial<RateLimitConfig> // Rate limiting configuration
    maxConnectionsPerPeer?: number // Max connections per peer identity (default: 2)
}

/**
 * OmniProtocolServer - Main TCP server for accepting incoming OmniProtocol connections
 *
 * Uses ConnectionPool as the single source of truth for all connections (both inbound and outbound).
 * Inbound connections are handled via connectionPool.handleInboundSocket() which creates
 * bidirectional PeerConnection instances that can be used for both receiving and sending messages.
 */
export class OmniProtocolServer extends EventEmitter {
    private server: NetServer | null = null
    public readonly connectionPool: ConnectionPool
    private config: ServerConfig
    private isRunning = false
    private rateLimiter: RateLimiter

    constructor(config: Partial<ServerConfig> = {}) {
        super()

        this.config = {
            host: config.host ?? "0.0.0.0",
            port: config.port ?? this.detectNodePort() + 1,
            maxConnections: config.maxConnections ?? 1000,
            connectionTimeout: config.connectionTimeout ?? 10 * 60 * 1000,
            authTimeout: config.authTimeout ?? 5000,
            backlog: config.backlog ?? 511,
            enableKeepalive: config.enableKeepalive ?? true,
            keepaliveInitialDelay: config.keepaliveInitialDelay ?? 60000,
            rateLimit: config.rateLimit,
            maxConnectionsPerPeer: config.maxConnectionsPerPeer ?? 2,
        }

        this.rateLimiter = RateLimiter.getInstance()
        this.connectionPool = ConnectionPool.getInstance(this.rateLimiter)

        // // Initialize connection pool as single source of truth for all connections
        // this.connectionPool = new ConnectionPool(
        //     {
        //         maxTotalConnections: this.config.maxConnections,
        //         maxConnectionsPerPeer: this.config.maxConnectionsPerPeer,
        //         idleTimeout: this.config.connectionTimeout,
        //         connectTimeout: this.config.authTimeout,
        //         authTimeout: this.config.authTimeout,
        //     },
        //     this.rateLimiter,
        // )
    }

    /**
     * Start TCP server and begin accepting connections
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("Server is already running")
        }

        return new Promise((resolve, reject) => {
            this.server = new NetServer()

            // Configure server options
            this.server.maxConnections = this.config.maxConnections

            // Handle new connections
            this.server.on("connection", (socket: Socket) => {
                this.handleNewConnection(socket)
            })

            // Handle server errors
            this.server.on("error", (error: Error) => {
                this.emit("error", error)
                log.error("[OmniProtocolServer] Server error: " + error)
            })

            // Handle server close
            this.server.on("close", () => {
                this.emit("close")
                log.info("[OmniProtocolServer] Server closed")
            })

            // Start listening
            this.server.listen(
                {
                    host: this.config.host,
                    port: this.config.port,
                    backlog: this.config.backlog,
                },
                () => {
                    this.isRunning = true
                    this.emit("listening", this.config.port)
                    log.info(
                        `[OmniProtocolServer] Listening on ${this.config.host}:${this.config.port}`,
                    )
                    resolve()
                },
            )

            this.server.once("error", reject)
        })
    }

    /**
     * Stop server and close all connections
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return
        }

        log.info("[OmniProtocolServer] Stopping server...")

        // Stop accepting new connections
        await new Promise<void>((resolve, reject) => {
            this.server?.close(err => {
                if (err) reject(err)
                else resolve()
            })
        })

        // Close all existing connections via connection pool
        await this.connectionPool.shutdown()

        // Stop rate limiter
        this.rateLimiter.stop()

        this.isRunning = false
        this.server = null

        log.info("[OmniProtocolServer] Server stopped")
    }

    /**
     * Handle new incoming connection
     *
     * Inbound connections are handled by the ConnectionPool which creates bidirectional
     * PeerConnection instances. After authentication, the connection is registered under
     * the peer's real identity and can be used for both receiving and sending messages.
     */
    private handleNewConnection(socket: Socket): void {
        const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`
        const ipAddress = socket.remoteAddress || "unknown"
        log.debug(
            `==== DEBUG: New connection request from ${remoteAddress} ====`,
        )
        // Log connection count from this IP for debugging
        const connectionCount =
            this.connectionPool.getConnectionCountByIp(ipAddress)
        log.debug(
            `[OmniProtocolServer] Connections from ${ipAddress}: ${connectionCount}`,
        )
        log.debug(`Connection count: ${connectionCount}`)

        // Check rate limits for IP
        const rateLimitResult = this.rateLimiter.checkConnection(
            ipAddress,
            "OmniProtocolServer",
        )

        if (!rateLimitResult.allowed) {
            log.error(
                `[OmniProtocolServer] Rate limit exceeded for ${remoteAddress}: ${rateLimitResult.reason}`,
            )
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "rate_limit")
            this.emit("rate_limit_exceeded", ipAddress, rateLimitResult)
            return
        }

        // Check if we're at capacity
        if (
            this.connectionPool.getTotalConnectionCount() >=
            this.config.maxConnections
        ) {
            log.error(
                `[OmniProtocolServer] Connection limit reached, rejecting ${remoteAddress}`,
            )
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "capacity")
            return
        }

        // Configure socket options
        if (this.config.enableKeepalive) {
            socket.setKeepAlive(true, this.config.keepaliveInitialDelay)
        }
        socket.setNoDelay(true) // Disable Nagle's algorithm for low latency

        // Hand off to connection pool - creates bidirectional PeerConnection
        try {
            const peerConnection =
                this.connectionPool.handleInboundSocket(socket)

            // Listen for authentication to emit event with peer identity
            peerConnection.once("authenticated", (peerIdentity: string) => {
                log.info(
                    `[OmniProtocolServer] Peer authenticated: ${peerIdentity} from ${remoteAddress}`,
                )
                this.emit("peer_authenticated", peerIdentity, remoteAddress)
            })

            // Listen for close to clean up rate limiter
            peerConnection.once("close", () => {
                this.rateLimiter.removeConnection(ipAddress)
            })

            this.emit("connection_accepted", remoteAddress)
        } catch (error) {
            log.error(
                `[OmniProtocolServer] Failed to handle connection from ${remoteAddress}: ` +
                    error,
            )
            this.rateLimiter.removeConnection(ipAddress)
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "error")
        }
    }

    /**
     * Get server statistics
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            port: this.config.port,
            connections: this.connectionPool.getStats(),
            rateLimit: this.rateLimiter.getStats(),
        }
    }

    /**
     * Get rate limiter instance (for manual control)
     */
    getRateLimiter(): RateLimiter {
        return this.rateLimiter
    }

    /**
     * Detect node's HTTP port from environment/config
     */
    private detectNodePort(): number {
        // Try to read from environment or config
        const httpPort = parseInt(
            process.env.NODE_PORT || process.env.PORT || "3000",
        )
        return httpPort
    }
}
