import log from "src/utilities/logger"
import * as tls from "tls"
import * as fs from "fs"
import { EventEmitter } from "events"
import { ServerConnectionManager } from "./ServerConnectionManager"
import type { TLSConfig } from "../tls/types"
import { DEFAULT_TLS_CONFIG } from "../tls/types"
import { loadCertificate } from "../tls/certificates"
import { RateLimiter, RateLimitConfig } from "../ratelimit"

export interface TLSServerConfig {
    host: string
    port: number
    maxConnections: number
    connectionTimeout: number
    authTimeout: number
    backlog: number
    tls: TLSConfig
    rateLimit?: Partial<RateLimitConfig>
}

/**
 * TLS-enabled OmniProtocol server
 * Wraps TCP server with TLS encryption
 */
export class TLSServer extends EventEmitter {
    private server: tls.Server | null = null
    private connectionManager: ServerConnectionManager
    private config: TLSServerConfig
    private isRunning = false
    private trustedFingerprints: Map<string, string> = new Map()
    private rateLimiter: RateLimiter

    constructor(config: Partial<TLSServerConfig>) {
        super()

        this.config = {
            host: config.host ?? "0.0.0.0",
            port: config.port ?? 3001,
            maxConnections: config.maxConnections ?? 1000,
            connectionTimeout: config.connectionTimeout ?? 600000,
            authTimeout: config.authTimeout ?? 5000,
            backlog: config.backlog ?? 511,
            tls: { ...DEFAULT_TLS_CONFIG, ...config.tls } as TLSConfig,
            rateLimit: config.rateLimit,
        }

        // Initialize rate limiter
        this.rateLimiter = new RateLimiter(
            this.config.rateLimit ?? { enabled: true },
        )

        this.connectionManager = new ServerConnectionManager({
            maxConnections: this.config.maxConnections,
            connectionTimeout: this.config.connectionTimeout,
            authTimeout: this.config.authTimeout,
            rateLimiter: this.rateLimiter,
        })

        // Load trusted fingerprints
        if (this.config.tls.trustedFingerprints) {
            this.trustedFingerprints = this.config.tls.trustedFingerprints
        }
    }

    /**
     * Start TLS server
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("TLS server is already running")
        }

        // Validate TLS configuration
        if (!fs.existsSync(this.config.tls.certPath)) {
            throw new Error(
                `Certificate not found: ${this.config.tls.certPath}`,
            )
        }
        if (!fs.existsSync(this.config.tls.keyPath)) {
            throw new Error(`Private key not found: ${this.config.tls.keyPath}`)
        }

        // Load certificate and key
        const certPem = fs.readFileSync(this.config.tls.certPath)
        const keyPem = fs.readFileSync(this.config.tls.keyPath)

        // Optional CA certificate
        let ca: Buffer | undefined
        if (this.config.tls.caPath && fs.existsSync(this.config.tls.caPath)) {
            ca = fs.readFileSync(this.config.tls.caPath)
        }

        return new Promise((resolve, reject) => {
            const tlsOptions: tls.TlsOptions = {
                key: keyPem,
                cert: certPem,
                ca,
                requestCert: this.config.tls.requestCert,
                rejectUnauthorized: false, // We do custom verification
                minVersion: this.config.tls.minVersion,
                ciphers: this.config.tls.ciphers,
            }

            this.server = tls.createServer(
                tlsOptions,
                (socket: tls.TLSSocket) => {
                    this.handleSecureConnection(socket)
                },
            )

            // Set max connections
            this.server.maxConnections = this.config.maxConnections

            // Handle server errors
            this.server.on("error", (error: Error) => {
                this.emit("error", error)
                log.error("[TLSServer] Server error: " + error)
            })

            // Handle server close
            this.server.on("close", () => {
                this.emit("close")
                log.info("[TLSServer] Server closed")
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
                        `[TLSServer] Listening on ${this.config.host}:${this.config.port} (TLS ${this.config.tls.minVersion})`,
                    )
                    resolve()
                },
            )

            this.server.once("error", reject)
        })
    }

    /**
     * Handle new secure (TLS) connection
     */
    private handleSecureConnection(socket: tls.TLSSocket): void {
        const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`
        const ipAddress = socket.remoteAddress || "unknown"

        log.debug(`[TLSServer] New TLS connection from ${remoteAddress}`)

        // Check rate limits for IP
        const rateLimitResult = this.rateLimiter.checkConnection(ipAddress)
        if (!rateLimitResult.allowed) {
            log.warning(
                `[TLSServer] Rate limit exceeded for ${remoteAddress}: ${rateLimitResult.reason}`,
            )
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "rate_limit")
            this.emit("rate_limit_exceeded", ipAddress, rateLimitResult)
            return
        }

        // Verify TLS connection is authorized
        if (!socket.authorized && this.config.tls.rejectUnauthorized) {
            log.warning(
                `[TLSServer] Unauthorized TLS connection from ${remoteAddress}: ${socket.authorizationError}`,
            )
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "unauthorized")
            return
        }

        // Verify certificate fingerprint if in self-signed mode
        if (
            this.config.tls.mode === "self-signed" &&
            this.config.tls.requestCert
        ) {
            const peerCert = socket.getPeerCertificate()
            if (!peerCert || !peerCert.fingerprint256) {
                log.warning(
                    `[TLSServer] No client certificate from ${remoteAddress}`,
                )
                socket.destroy()
                this.emit("connection_rejected", remoteAddress, "no_cert")
                return
            }

            // If we have trusted fingerprints, verify against them
            if (this.trustedFingerprints.size > 0) {
                const fingerprint = peerCert.fingerprint256
                const isTrusted = Array.from(
                    this.trustedFingerprints.values(),
                ).includes(fingerprint)

                if (!isTrusted) {
                    log.warning(
                        `[TLSServer] Untrusted certificate from ${remoteAddress}: ${fingerprint}`,
                    )
                    socket.destroy()
                    this.emit(
                        "connection_rejected",
                        remoteAddress,
                        "untrusted_cert",
                    )
                    return
                }

                log.debug(
                    `[TLSServer] Verified trusted certificate: ${fingerprint.substring(0, 16)}...`,
                )
            }
        }

        // Check connection limit
        if (
            this.connectionManager.getConnectionCount() >=
            this.config.maxConnections
        ) {
            log.warning(
                `[TLSServer] Connection limit reached, rejecting ${remoteAddress}`,
            )
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "capacity")
            return
        }

        // Configure socket
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 60000)

        // Get TLS info for logging
        const protocol = socket.getProtocol()
        const cipher = socket.getCipher()
        log.debug(
            `[TLSServer] TLS ${protocol} with ${cipher?.name || "unknown cipher"}`,
        )

        // Register connection with rate limiter
        this.rateLimiter.addConnection(ipAddress)

        // Hand off to connection manager
        try {
            this.connectionManager.handleConnection(socket)
            this.emit("connection_accepted", remoteAddress)
        } catch (error) {
            log.error(
                `[TLSServer] Failed to handle connection from ${remoteAddress}: ` +
                    error,
            )
            this.rateLimiter.removeConnection(ipAddress)
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "error")
        }
    }

    /**
     * Stop server gracefully
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return
        }

        log.info("[TLSServer] Stopping server...")

        // Stop accepting new connections
        await new Promise<void>((resolve, reject) => {
            this.server?.close(err => {
                if (err) reject(err)
                else resolve()
            })
        })

        // Close all existing connections
        await this.connectionManager.closeAll()

        // Stop rate limiter
        this.rateLimiter.stop()

        this.isRunning = false
        this.server = null

        log.info("[TLSServer] Server stopped")
    }

    /**
     * Add trusted peer certificate fingerprint
     */
    addTrustedFingerprint(peerIdentity: string, fingerprint: string): void {
        this.trustedFingerprints.set(peerIdentity, fingerprint)
        log.debug(
            `[TLSServer] Added trusted fingerprint for ${peerIdentity}: ${fingerprint.substring(0, 16)}...`,
        )
    }

    /**
     * Remove trusted peer certificate fingerprint
     */
    removeTrustedFingerprint(peerIdentity: string): void {
        this.trustedFingerprints.delete(peerIdentity)
        log.debug(`[TLSServer] Removed trusted fingerprint for ${peerIdentity}`)
    }

    /**
     * Get server statistics
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            port: this.config.port,
            tlsEnabled: true,
            tlsVersion: this.config.tls.minVersion,
            trustedPeers: this.trustedFingerprints.size,
            connections: this.connectionManager.getStats(),
            rateLimit: this.rateLimiter.getStats(),
        }
    }

    /**
     * Get rate limiter instance (for manual control)
     */
    getRateLimiter(): RateLimiter {
        return this.rateLimiter
    }
}
