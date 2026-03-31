import log from "src/utilities/logger"
import * as tls from "tls"
import * as fs from "fs"
import { PeerConnection } from "./PeerConnection"
import type { ConnectionOptions } from "./types"
import type { TLSConfig } from "../tls/types"
import { loadCertificate } from "../tls/certificates"

/**
 * TLS-enabled peer connection
 * Extends PeerConnection to use TLS instead of plain TCP
 */
export class TLSConnection extends PeerConnection {
    private tlsConfig: TLSConfig
    private trustedFingerprints: Map<string, string> = new Map()

    constructor(
        peerIdentity: string,
        connectionString: string,
        tlsConfig: TLSConfig,
    ) {
        super(peerIdentity, connectionString)
        this.tlsConfig = tlsConfig

        if (tlsConfig.trustedFingerprints) {
            this.trustedFingerprints = tlsConfig.trustedFingerprints
        }
    }

    /**
     * Establish TLS connection to peer
     * Overrides parent connect() method
     */
    async connect(options: ConnectionOptions = {}): Promise<void> {
        if (
            this.getState() !== "UNINITIALIZED" &&
            this.getState() !== "CLOSED"
        ) {
            throw new Error(
                `Cannot connect from state ${this.getState()}, must be UNINITIALIZED or CLOSED`,
            )
        }

        // Parse connection string
        const parsed = this.parseConnectionString()
        this.setState("CONNECTING")

        // Validate TLS configuration
        if (!fs.existsSync(this.tlsConfig.certPath)) {
            throw new Error(`Certificate not found: ${this.tlsConfig.certPath}`)
        }
        if (!fs.existsSync(this.tlsConfig.keyPath)) {
            throw new Error(`Private key not found: ${this.tlsConfig.keyPath}`)
        }

        // Load certificate and key
        const certPem = fs.readFileSync(this.tlsConfig.certPath)
        const keyPem = fs.readFileSync(this.tlsConfig.keyPath)

        // Optional CA certificate
        let ca: Buffer | undefined
        if (this.tlsConfig.caPath && fs.existsSync(this.tlsConfig.caPath)) {
            ca = fs.readFileSync(this.tlsConfig.caPath)
        }

        return new Promise((resolve, reject) => {
            const timeout = options.timeout ?? 5000

            const timeoutTimer = setTimeout(() => {
                if (this.socket) {
                    this.socket.destroy()
                }
                this.setState("ERROR")
                reject(new Error(`TLS connection timeout after ${timeout}ms`))
            }, timeout)

            const tlsOptions: tls.ConnectionOptions = {
                host: parsed.host,
                port: parsed.port,
                key: keyPem,
                cert: certPem,
                ca,
                rejectUnauthorized: false, // We do custom verification
                minVersion: this.tlsConfig.minVersion,
                ciphers: this.tlsConfig.ciphers,
            }

            const socket = tls.connect(tlsOptions)

            socket.on("secureConnect", () => {
                clearTimeout(timeoutTimer)

                // Verify server certificate
                if (!this.verifyServerCertificate(socket)) {
                    socket.destroy()
                    this.setState("ERROR")
                    reject(new Error("Server certificate verification failed"))
                    return
                }

                // Store socket
                this.setSocket(socket)
                this.setState("READY")

                // Log TLS info
                const protocol = socket.getProtocol()
                const cipher = socket.getCipher()
                log.info(
                    `[TLSConnection] Connected with TLS ${protocol} using ${cipher?.name || "unknown cipher"}`,
                )

                resolve()
            })

            socket.on("error", (error: Error) => {
                clearTimeout(timeoutTimer)
                this.setState("ERROR")
                log.error("[TLSConnection] Connection error: " + error)
                reject(error)
            })
        })
    }

    /**
     * Verify server certificate
     */
    private verifyServerCertificate(socket: tls.TLSSocket): boolean {
        // Check if TLS handshake succeeded
        if (!socket.authorized && this.tlsConfig.rejectUnauthorized) {
            log.error(
                `[TLSConnection] Unauthorized server: ${socket.authorizationError}`,
            )
            return false
        }

        // In self-signed mode, verify certificate fingerprint
        if (this.tlsConfig.mode === "self-signed") {
            const cert = socket.getPeerCertificate()
            if (!cert || !cert.fingerprint256) {
                log.error("[TLSConnection] No server certificate")
                return false
            }

            const fingerprint = cert.fingerprint256

            // If we have a trusted fingerprint for this peer, verify it
            const trustedFingerprint = this.trustedFingerprints.get(
                this.peerIdentity,
            )
            if (trustedFingerprint) {
                if (trustedFingerprint !== fingerprint) {
                    log.error(
                        `[TLSConnection] Certificate fingerprint mismatch for ${this.peerIdentity}`,
                    )
                    log.error(`  Expected: ${trustedFingerprint}`)
                    log.error(`  Got: ${fingerprint}`)
                    return false
                }

                log.info(
                    `[TLSConnection] Verified trusted certificate: ${fingerprint.substring(0, 16)}...`,
                )
            } else {
                // No trusted fingerprint stored - this is the first connection
                // Log the fingerprint so it can be pinned
                log.warning(
                    `[TLSConnection] No trusted fingerprint for ${this.peerIdentity}`,
                )
                log.warning(`  Server certificate fingerprint: ${fingerprint}`)
                log.warning(
                    "  Add to trustedFingerprints to pin this certificate",
                )

                // In strict mode, reject unknown certificates
                if (this.tlsConfig.rejectUnauthorized) {
                    log.error("[TLSConnection] Rejecting unknown certificate")
                    return false
                }
            }

            // Log certificate details
            log.debug("[TLSConnection] Server certificate:")
            log.debug(`  Subject: ${cert.subject.CN}`)
            log.debug(`  Issuer: ${cert.issuer.CN}`)
            log.debug(`  Valid from: ${cert.valid_from}`)
            log.debug(`  Valid to: ${cert.valid_to}`)
        }

        return true
    }

    /**
     * Add trusted peer certificate fingerprint
     */
    addTrustedFingerprint(fingerprint: string): void {
        this.trustedFingerprints.set(this.peerIdentity, fingerprint)
        log.info(
            `[TLSConnection] Added trusted fingerprint for ${this.peerIdentity}: ${fingerprint.substring(0, 16)}...`,
        )
    }

    /**
     * Helper to set socket (parent class has protected socket)
     */
    private setSocket(socket: tls.TLSSocket): void {
        this.socket = socket
    }

    /**
     * Helper to get parsed connection
     */
    private parseConnectionString() {
        if (!this.parsedConnection) {
            // Parse manually
            const url = new URL(this.connectionString)
            return {
                protocol: url.protocol.replace(":", ""),
                host: url.hostname,
                port: parseInt(url.port) || 3001,
            }
        }
        return this.parsedConnection
    }
}
