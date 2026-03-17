// REVIEW: PeerConnection - Bidirectional TCP socket wrapper for peer connections
import log from "src/utilities/logger"
import { Socket } from "net"
import { EventEmitter } from "events"
import forge from "node-forge"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { MessageFramer } from "./MessageFramer"
import type { OmniMessageHeader, ParsedOmniMessage } from "../types/message"
import type { AuthBlock } from "../auth/types"
import { SignatureAlgorithm, SignatureMode } from "../auth/types"
import {
    ConnectionState,
    ConnectionStateValue,
    ConnectionStateUtils,
    SequenceIdRange,
    type ConnectionOrigin,
    type ConnectionOptions,
    type PendingRequest,
    type ConnectionInfo,
    type ParsedConnectionString,
    parseConnectionString,
} from "./types"
import {
    ConnectionTimeoutError,
    SigningError,
    InvalidAuthBlockFormatError,
    ConnectionError,
} from "../types/errors"
import { dispatchOmniMessage } from "../protocol/dispatcher"
import { RateLimiter } from "../ratelimit"
import { ConnectionPool } from "./ConnectionPool"

/**
 * Global sequence ID manager for the node.
 * Ensures unique sequence IDs across all connections,
 * enabling cross-connection response routing.
 * Wraps around when range is exhausted.
 */
class SequenceManager {
    private static outboundSequence: number = SequenceIdRange.OUTBOUND_START

    static next(): number {
        const seq = this.outboundSequence++
        if (this.outboundSequence > SequenceIdRange.OUTBOUND_END) {
            this.outboundSequence = SequenceIdRange.OUTBOUND_START
        }
        return seq
    }
}

/**
 * Search sibling connections for an in-flight request.
 * Used when response arrives on different connection than request was sent.
 */
function findInFlightRequestAcrossConnections(
    peerIdentity: string,
    sequence: number,
    excludeConnection: PeerConnection,
): { connection: PeerConnection; pending: PendingRequest } | undefined {
    const pool = ConnectionPool.getInstance()
    const connections = pool.getConnections(peerIdentity)

    for (const conn of connections) {
        if (conn === excludeConnection) continue
        const pending = conn.inFlightRequests.get(sequence)
        if (pending) {
            return { connection: conn, pending }
        }
    }

    return undefined
}

/**
 * PeerConnection manages a single bidirectional TCP connection to a peer node
 *
 * Supports both:
 * - OUTBOUND connections: We initiate TCP connect to remote peer
 * - INBOUND connections: Remote peer connects to us (socket passed to constructor)
 *
 * State machine (numeric scale):
 * - Negative: Terminal states (ERROR, CLOSED, CLOSING)
 * - Zero: UNINITIALIZED (outbound only)
 * - 1-9: Connecting states (CONNECTING, CONNECTED, PENDING_AUTH)
 * - 10+: Usable states (AUTHENTICATED, READY, IDLE)
 *
 * Features:
 * - Bidirectional message handling (can send AND receive requests)
 * - Message framing using MessageFramer for parsing TCP stream
 * - Request-response correlation via sequence IDs (partitioned by origin)
 * - Idle timeout with graceful transition
 * - In-flight request tracking with timeout handling
 */
export class PeerConnection extends EventEmitter {
    public socket: Socket | null = null
    private framer: MessageFramer = new MessageFramer()
    private _state: ConnectionStateValue
    private _peerIdentity: string
    private connectionString: string
    private parsedConnection: ParsedConnectionString | null = null

    /**
     * Connection origin - who initiated the TCP connection
     * 'outbound': We connected to the peer
     * 'inbound': Peer connected to us
     */
    public readonly origin: ConnectionOrigin

    // Request tracking for outbound requests we send
    // Public for cross-connection response routing (fallback lookup)
    public readonly inFlightRequests: Map<number, PendingRequest> = new Map()

    // Timing and lifecycle
    private idleTimer: NodeJS.Timeout | null = null
    private authTimer: NodeJS.Timeout | null = null
    private idleTimeout: number = 10 * 60 * 1000 // 10 minutes default
    private connectTimeout = 5000 // 5 seconds
    private authTimeout = 5000 // 5 seconds
    private connectedAt: number | null = null
    private createdAt: number = Date.now()
    private lastActivity: number = Date.now()

    // Rate limiting (for inbound connections)
    private rateLimiter?: RateLimiter

    /**
     * Create a new PeerConnection
     *
     * @param peerIdentity Peer public key or identifier (can be temporary for inbound until auth)
     * @param connectionString Connection string (e.g., "tcp://ip:port") - empty for inbound
     * @param socket Optional existing socket for inbound connections
     * @param rateLimiter Optional rate limiter for inbound request throttling
     */
    constructor(
        peerIdentity: string,
        connectionString: string,
        socket?: Socket,
        rateLimiter?: RateLimiter,
    ) {
        super()
        this._peerIdentity = peerIdentity
        this.connectionString = connectionString
        this.rateLimiter = rateLimiter

        if (socket) {
            // INBOUND connection - socket already connected
            this.origin = "inbound"
            this.socket = socket
            this._state = ConnectionState.PENDING_AUTH
            this.connectedAt = Date.now()
            this.setupSocketHandlers()
            this.startAuthTimeout()
        } else {
            // OUTBOUND connection - will connect later
            this.origin = "outbound"
            this._state = ConnectionState.UNINITIALIZED
        }
    }

    /**
     * Get current peer identity
     */
    get peerIdentity(): string {
        return this._peerIdentity
    }

    /**
     * Update peer identity (used after authentication for inbound connections)
     */
    setPeerIdentity(identity: string): void {
        const oldIdentity = this._peerIdentity
        this._peerIdentity = identity
        if (oldIdentity !== identity) {
            this.emit("identityChanged", { from: oldIdentity, to: identity })
        }
    }

    /**
     * Get current connection state
     */
    getState(): ConnectionStateValue {
        return this._state
    }

    /**
     * Get unique socket identifier that is reproducible on both sides of the connection.
     *
     * The ID is a keccak256 hash of the sorted endpoints (ip:port pairs), ensuring
     * both the client and server compute the same identifier for the same connection.
     *
     * @returns Hex string hash of the socket endpoints, or null if socket not connected
     */
    get socketId(): string | null {
        if (
            !this.socket ||
            !this.socket.localAddress ||
            !this.socket.remoteAddress
        ) {
            return null
        }

        const localEndpoint = `${this.socket.localAddress}:${this.socket.localPort}`
        const remoteEndpoint = `${this.socket.remoteAddress}:${this.socket.remotePort}`

        // Sort endpoints so both sides produce the same hash
        const endpoints = [localEndpoint, remoteEndpoint].sort()
        const data = endpoints.join("|")

        // Hash with keccak256 for a compact, unique identifier
        const hash = keccak_256(Buffer.from(data, "utf8"))
        return Buffer.from(hash).toString("hex")
    }

    /**
     * Check if connection can be used for messaging
     */
    isUsable(): boolean {
        return ConnectionStateUtils.isUsable(this._state)
    }

    /**
     * Check if connection is ready for requests
     */
    isReady(): boolean {
        return this._state === ConnectionState.READY
    }

    /**
     * Establish TCP connection to peer (OUTBOUND only)
     *
     * @param options Connection options (timeout, retries)
     * @returns Promise that resolves when connection is READY
     */
    async connect(options: ConnectionOptions = {}): Promise<void> {
        if (this.origin === "inbound") {
            throw new Error("Cannot call connect() on inbound connection")
        }

        if (
            this._state !== ConnectionState.UNINITIALIZED &&
            this._state !== ConnectionState.CLOSED
        ) {
            throw new Error(
                `Cannot connect from state ${ConnectionStateUtils.getName(
                    this._state,
                )}, must be UNINITIALIZED or CLOSED`,
            )
        }

        this.parsedConnection = parseConnectionString(this.connectionString)
        this.setState(ConnectionState.CONNECTING)

        return new Promise((resolve, reject) => {
            const timeout = options.timeout ?? this.connectTimeout

            const timeoutTimer = setTimeout(() => {
                if (this.socket) {
                    this.socket.removeAllListeners()
                    this.socket.destroy()
                }

                this.setState(ConnectionState.ERROR)
                reject(
                    new ConnectionTimeoutError(
                        `Connection timeout after ${timeout}ms`,
                    ),
                )
            }, timeout)

            this.socket = new Socket()
            this.socket.setKeepAlive(true, 30_000)

            this.socket.on("connect", () => {
                clearTimeout(timeoutTimer)
                this.connectedAt = Date.now()
                this.resetIdleTimer()

                // For outbound, move directly to READY (peer is in our peerlist)
                this.setState(ConnectionState.READY)
                resolve()
            })

            this.setupSocketHandlers()

            this.socket.on("error", (error: Error) => {
                clearTimeout(timeoutTimer)
                this.setState(ConnectionState.ERROR)
                reject(error)
            })

            // Initiate connection
            this.socket.connect(
                this.parsedConnection.port,
                this.parsedConnection.host,
            )
        })
    }

    /**
     * Setup socket event handlers
     */
    private setupSocketHandlers(): void {
        if (!this.socket) return

        this.socket.on("data", (chunk: Buffer) => {
            this.handleIncomingData(chunk)
        })

        this.socket.on("close", () => {
            this.handleSocketClose()
        })

        this.socket.on("error", (error: Error) => {
            log.error(
                `[PeerConnection] ${this._peerIdentity} socket error: ${error}`,
            )
            this.emit("error", error)
        })

        // Configure socket options
        this.socket.setNoDelay(true) // Disable Nagle's algorithm for low latency
    }

    /**
     * Start authentication timeout for inbound connections
     */
    private startAuthTimeout(): void {
        if (this.origin !== "inbound") return

        this.authTimer = setTimeout(() => {
            if (this._state === ConnectionState.PENDING_AUTH) {
                log.warning(
                    `[PeerConnection] ${this._peerIdentity} authentication timeout`,
                )
                this.close()
            }
        }, this.authTimeout)
    }

    /**
     * Send request and await response (request-response pattern)
     *
     * @param opcode OmniProtocol opcode
     * @param payload Message payload
     * @param options Request options (timeout)
     * @returns Promise resolving to response payload
     */
    async send(
        opcode: number,
        payload: Buffer,
        options: ConnectionOptions = {},
    ): Promise<Buffer> {
        if (!this.isUsable()) {
            throw new Error(
                `Cannot send message in state ${ConnectionStateUtils.getName(
                    this._state,
                )}, must be AUTHENTICATED or READY`,
            )
        }

        const sequence = SequenceManager.next()
        const timeout = options.timeout ?? 30000 // 30 second default

        return new Promise((resolve, reject) => {
            const timeoutTimer = setTimeout(() => {
                this.inFlightRequests.delete(sequence)
                reject(
                    new ConnectionTimeoutError(
                        `Request timeout after ${timeout}ms`,
                    ),
                )
            }, timeout)

            // Store pending request for response correlation
            this.inFlightRequests.set(sequence, {
                resolve,
                reject,
                timer: timeoutTimer,
                sentAt: Date.now(),
            })

            // Encode and send message
            const header: OmniMessageHeader = {
                version: 1,
                opcode,
                sequence,
                payloadLength: payload.length,
            }

            const messageBuffer = MessageFramer.encodeMessage(header, payload)
            this.socket.write(messageBuffer)

            this.lastActivity = Date.now()
            this.resetIdleTimer()
        })
    }

    /**
     * Send authenticated request and await response
     *
     * @param opcode OmniProtocol opcode
     * @param payload Message payload
     * @param privateKey Ed25519 private key for signing
     * @param publicKey Ed25519 public key for identity
     * @param options Request options (timeout)
     * @returns Promise resolving to response payload
     */
    async sendAuthenticated(
        opcode: number,
        payload: Buffer,
        privateKey: Buffer,
        publicKey: Buffer,
        options: ConnectionOptions = {},
    ): Promise<Buffer> {
        if (!this.isUsable()) {
            throw new Error(
                `Cannot send message in state ${ConnectionStateUtils.getName(
                    this._state,
                )}, must be AUTHENTICATED or READY`,
            )
        }

        const sequence = SequenceManager.next()
        const timeout = options.timeout ?? 30000 // 30 second default
        const timestamp = Date.now()

        // Build data to sign: Message ID + Keccak256(Payload)
        const msgIdBuf = Buffer.allocUnsafe(4)
        msgIdBuf.writeUInt32BE(sequence)
        const payloadHash = Buffer.from(keccak_256(payload))
        const dataToSign = Buffer.concat([msgIdBuf, payloadHash])

        // Sign with Ed25519 using node-forge
        let signature: Uint8Array
        try {
            const signatureBuffer = forge.pki.ed25519.sign({
                message: dataToSign,
                privateKey: privateKey as forge.pki.ed25519.NativeBuffer,
            })
            signature = new Uint8Array(signatureBuffer)
        } catch (error) {
            throw new SigningError(
                `Ed25519 signing failed (privateKey length: ${
                    privateKey.length
                } bytes): ${error instanceof Error ? error.message : error}`,
                error instanceof Error ? error : undefined,
            )
        }

        // Build auth block
        const auth: AuthBlock = {
            algorithm: SignatureAlgorithm.ED25519,
            signatureMode: SignatureMode.SIGN_MESSAGE_ID_PAYLOAD_HASH,
            timestamp,
            identity: publicKey,
            signature: Buffer.from(signature),
        }

        return new Promise((resolve, reject) => {
            const timeoutTimer = setTimeout(() => {
                this.inFlightRequests.delete(sequence)
                reject(
                    new ConnectionTimeoutError(
                        `Request timeout after ${timeout}ms`,
                    ),
                )
            }, timeout)

            // Store pending request for response correlation
            this.inFlightRequests.set(sequence, {
                resolve,
                reject,
                timer: timeoutTimer,
                sentAt: Date.now(),
            })

            // Encode and send message with auth
            const header: OmniMessageHeader = {
                version: 1,
                opcode,
                sequence,
                payloadLength: payload.length,
            }

            const messageBuffer = MessageFramer.encodeMessage(
                header,
                payload,
                auth,
            )
            this.socket.write(messageBuffer)

            this.lastActivity = Date.now()
            this.resetIdleTimer()
        })
    }

    /**
     * Send one-way message (fire-and-forget, no response expected)
     *
     * @param opcode OmniProtocol opcode
     * @param payload Message payload
     */
    sendOneWay(opcode: number, payload: Buffer): void {
        if (!this.isUsable()) {
            throw new Error(
                `Cannot send message in state ${ConnectionStateUtils.getName(
                    this._state,
                )}, must be AUTHENTICATED or READY`,
            )
        }

        const sequence = SequenceManager.next()

        const header: OmniMessageHeader = {
            version: 1,
            opcode,
            sequence,
            payloadLength: payload.length,
        }

        const messageBuffer = MessageFramer.encodeMessage(header, payload)
        this.socket.write(messageBuffer)

        this.lastActivity = Date.now()
        this.resetIdleTimer()
    }

    /**
     * Send response to an incoming request
     *
     * @param sequence Original request sequence ID
     * @param payload Response payload
     */
    async sendResponse(sequence: number, payload: Buffer): Promise<void> {
        let socketId: string | null = null
        let socket: Socket | null = null

        if (this.socket?.writable) {
            socket = this.socket
            socketId = this.socketId
        } else {
            // TRY: Find other usable connection to peer
            const pool = ConnectionPool.getInstance()
            const connections = pool.getConnections(this._peerIdentity)

            for (const connection of connections) {
                if (
                    connection.socketId !== this.socketId &&
                    connection.socket?.writable
                ) {
                    socket = connection.socket
                    socketId = connection.socketId
                    break
                }
            }
        }

        if (!socket) {
            // INFO: We can't find a connection to peer,
            // RETURN!
            return
        }

        const header: OmniMessageHeader = {
            version: 1,
            opcode: 0xff, // Generic response opcode
            sequence,
            payloadLength: payload.length,
        }

        const messageBuffer = MessageFramer.encodeMessage(header, payload)
        return new Promise((resolve, reject) => {
            socket.write(messageBuffer, (error: any) => {
                if (error) {
                    log.error(
                        `Error while sending response via [${
                            socketId === this.socketId ? "primary" : "secondary"
                        }] socket ID: ${socketId} `,
                    )
                    log.error(
                        `[PeerConnection] Peer: ${this._peerIdentity}, write error: ${error}`,
                    )
                    reject(error)
                } else {
                    resolve()
                }
            })
        })
    }

    /**
     * Send error response to an incoming request
     *
     * @param sequence Original request sequence ID
     * @param errorCode Error code (2 bytes)
     * @param errorMessage Error message string
     */
    async sendErrorResponse(
        sequence: number,
        errorCode: number,
        errorMessage: string,
    ): Promise<void> {
        if (!this.socket.writable) {
            log.error(
                "Attempted to send error response to a closed connection, returning!",
            )
            return
        }

        const messageBuffer = Buffer.from(errorMessage, "utf8")
        const payload = Buffer.allocUnsafe(2 + messageBuffer.length)
        payload.writeUInt16BE(errorCode, 0)
        messageBuffer.copy(payload, 2)

        return this.sendResponse(sequence, payload)
    }

    /**
     * Gracefully close the connection
     * Sends proto_disconnect (0xF4) before closing socket
     */
    async close(): Promise<void> {
        if (
            this._state === ConnectionState.CLOSED ||
            this._state === ConnectionState.CLOSING
        ) {
            return
        }

        this.setState(ConnectionState.CLOSING)

        // Clear timers
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
            this.idleTimer = null
        }
        if (this.authTimer) {
            clearTimeout(this.authTimer)
            this.authTimer = null
        }

        // Reject all pending requests
        for (const [, pending] of this.inFlightRequests) {
            clearTimeout(pending.timer)
            pending.reject(new Error("Connection closing"))
        }
        this.inFlightRequests.clear()

        // Send proto_disconnect (0xF4) if socket is available and usable
        if (this.socket && this.isUsable()) {
            try {
                this.sendOneWay(0xf4, Buffer.alloc(0))
            } catch {
                // Ignore errors during disconnect
            }
        }

        // Close socket
        return new Promise(resolve => {
            if (this.socket) {
                this.socket.once("close", () => {
                    this.setState(ConnectionState.CLOSED)
                    resolve()
                })
                this.socket.end()
            } else {
                this.setState(ConnectionState.CLOSED)
                resolve()
            }
        })
    }

    /**
     * Get connection information for monitoring
     */
    getInfo(): ConnectionInfo & {
        origin: ConnectionOrigin
        createdAt: number
    } {
        return {
            peerIdentity: this._peerIdentity,
            connectionString: this.connectionString,
            state: this._state,
            connectedAt: this.connectedAt,
            lastActivity: this.lastActivity,
            inFlightCount: this.inFlightRequests.size,
            origin: this.origin,
            createdAt: this.createdAt,
        }
    }

    /**
     * Get last activity timestamp
     */
    getLastActivity(): number {
        return this.lastActivity
    }

    /**
     * Get created at timestamp
     */
    getCreatedAt(): number {
        return this.createdAt
    }

    /**
     * Handle incoming TCP data
     */
    private handleIncomingData(chunk: Buffer): void {
        this.lastActivity = Date.now()
        this.resetIdleTimer()

        // Add data to framer
        this.framer.addData(chunk)

        try {
            // Extract all complete messages
            let message = this.framer.extractMessage()
            while (message) {
                this.handleMessage(message)
                message = this.framer.extractMessage()
            }
        } catch (error) {
            console.error(error)
            if (error instanceof InvalidAuthBlockFormatError) {
                return
            }
        }
    }

    /**
     * Handle a complete decoded message - bidirectional demultiplexing
     *
     * Determines if message is:
     * 1. A RESPONSE to our outbound request (resolve pending promise)
     * 2. An incoming REQUEST from peer (dispatch to handler)
     */
    private async handleMessage(message: ParsedOmniMessage): Promise<void> {
        const { header, payload, auth } = message

        if (header.opcode === 0xff) {
            // Check if this is a RESPONSE to our outbound request
            const pending = this.inFlightRequests.get(header.sequence)
            if (pending) {
                // This is a response - resolve the pending request
                clearTimeout(pending.timer)
                this.inFlightRequests.delete(header.sequence)
                pending.resolve(payload as Buffer)
                return
            }

            // Fallback: Check sibling connections for cross-connection response routing
            // This handles the case where request was sent on connection A but response arrives on connection B
            const crossConnection = findInFlightRequestAcrossConnections(
                this._peerIdentity,
                header.sequence,
                this,
            )
            if (crossConnection) {
                const { connection, pending: crossPending } = crossConnection
                clearTimeout(crossPending.timer)
                this.inFlightRequests.delete(header.sequence)
                crossPending.resolve(payload as Buffer)
                log.debug(
                    `[PeerConnection] ${this._peerIdentity} resolved cross-connection response for sequence ${header.sequence}`,
                )
                return
            }

            // INFO: We can't find a matching in-flight request,
            return
        }

        // Otherwise, it's an incoming REQUEST - dispatch to handler
        await this.handleIncomingRequest(header, payload as Buffer, auth)
    }

    /**
     * Handle an incoming request from peer
     * Performs authentication, rate limiting, and dispatches to appropriate handler
     */
    private async handleIncomingRequest(
        header: OmniMessageHeader,
        payload: Buffer,
        auth: AuthBlock | null,
    ): Promise<void> {
        log.debug(
            `[PeerConnection] ${
                this._peerIdentity
            } received request opcode 0x${header.opcode.toString(16)}`,
        )

        // Extract peer identity from auth block for ANY authenticated message
        if (
            auth &&
            auth.identity &&
            this._state === ConnectionState.PENDING_AUTH
        ) {
            const newIdentity = "0x" + auth.identity.toString("hex")
            this.setPeerIdentity(newIdentity)
            this.setState(ConnectionState.READY)

            if (this.authTimer) {
                clearTimeout(this.authTimer)
                this.authTimer = null
            }

            this.emit("authenticated", newIdentity)
            log.info(
                `[PeerConnection] ${this._peerIdentity} authenticated via auth block`,
            )
        }

        // Check rate limits (for inbound connections)
        if (this.rateLimiter) {
            const ipAddress = this.socket?.remoteAddress || "unknown"

            // Check IP-based rate limit
            const ipResult = this.rateLimiter.checkIPRequest(ipAddress)
            if (!ipResult.allowed) {
                log.warning(
                    `[PeerConnection] ${this._peerIdentity} IP rate limit exceeded: ${ipResult.reason}`,
                )
                await this.sendErrorResponse(
                    header.sequence,
                    0xf429, // Too Many Requests
                    ipResult.reason || "Rate limit exceeded",
                )
                return
            }

            // Check identity-based rate limit
            if (this.isUsable()) {
                const identityResult = this.rateLimiter.checkIdentityRequest(
                    this._peerIdentity,
                )
                if (!identityResult.allowed) {
                    log.warning(
                        `[PeerConnection] ${this._peerIdentity} identity rate limit exceeded: ${identityResult.reason}`,
                    )
                    await this.sendErrorResponse(
                        header.sequence,
                        0xf429,
                        identityResult.reason || "Rate limit exceeded",
                    )
                    return
                }
            }
        }

        try {
            // Dispatch to handler
            const responsePayload = await dispatchOmniMessage({
                message: { header, payload, auth },
                context: {
                    peerIdentity: this._peerIdentity,
                    connectionId: `${this.socket?.remoteAddress}:${this.socket?.remotePort}`,
                    remoteAddress: this.socket?.remoteAddress || "unknown",
                    isAuthenticated: this.isUsable(),
                },
                fallbackToHttp: async () => {
                    throw new Error(
                        "HTTP fallback not available on server side",
                    )
                },
            })

            // Send response
            await this.sendResponse(header.sequence, responsePayload)
        } catch (error) {
            console.error(error)

            if (error instanceof ConnectionError) {
                log.error(
                    `[PeerConnection] ${this._peerIdentity} handler error: ${error}`,
                )
                this.emit("error", error)
                return
            }

            log.error(
                `[PeerConnection] ${this._peerIdentity} handler error: ${error}`,
            )

            // Send error response
            const errorPayload = Buffer.from(
                JSON.stringify({ error: String(error) }),
            )
            await this.sendResponse(header.sequence, errorPayload)
        }
    }

    /**
     * Handle socket close event
     */
    private handleSocketClose(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
            this.idleTimer = null
        }
        if (this.authTimer) {
            clearTimeout(this.authTimer)
            this.authTimer = null
        }

        // Reject all pending requests
        for (const [, pending] of this.inFlightRequests) {
            clearTimeout(pending.timer)
            pending.reject(new Error("Connection closed"))
        }
        this.inFlightRequests.clear()

        if (
            this._state !== ConnectionState.CLOSING &&
            this._state !== ConnectionState.CLOSED
        ) {
            this.setState(ConnectionState.CLOSED)
        }

        this.emit("close")
    }

    /**
     * Reset idle timeout timer
     */
    private resetIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
        }

        this.idleTimer = setTimeout(() => {
            if (this.isUsable() && this.inFlightRequests.size === 0) {
                this.setState(ConnectionState.IDLE)
                this.emit("idle")
            }
        }, this.idleTimeout)
    }

    /**
     * Transition to new state with validation
     */
    private setState(newState: ConnectionStateValue): void {
        const oldState = this._state

        if (!ConnectionStateUtils.canTransition(oldState, newState)) {
            log.warning(
                `[PeerConnection] Invalid state transition: ${ConnectionStateUtils.getName(
                    oldState,
                )} → ${ConnectionStateUtils.getName(newState)}`,
            )
            return
        }

        this._state = newState

        if (oldState !== newState) {
            log.debug(
                `[PeerConnection] ${
                    this._peerIdentity
                } state: ${ConnectionStateUtils.getName(
                    oldState,
                )} → ${ConnectionStateUtils.getName(newState)}`,
            )
            this.emit("stateChange", { from: oldState, to: newState })
        }
    }
}
