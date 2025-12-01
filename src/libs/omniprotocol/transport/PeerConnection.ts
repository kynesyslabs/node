// REVIEW: PeerConnection - TCP socket wrapper for single peer connection with state management
import { Socket } from "net"
import * as ed25519 from "@noble/ed25519"
import { sha256 } from "@noble/hashes/sha256"
import { MessageFramer } from "./MessageFramer"
import type { OmniMessageHeader } from "../types/message"
import type { AuthBlock } from "../auth/types"
import { SignatureAlgorithm, SignatureMode } from "../auth/types"
import type {
    ConnectionState,
    ConnectionOptions,
    PendingRequest,
    ConnectionInfo,
    ParsedConnectionString,
} from "./types"
import { parseConnectionString } from "./types"
import {
    ConnectionTimeoutError,
    AuthenticationError,
    SigningError,
} from "../types/errors"

/**
 * PeerConnection manages a single TCP connection to a peer node
 *
 * State machine:
 * UNINITIALIZED → CONNECTING → AUTHENTICATING → READY → IDLE_PENDING → CLOSING → CLOSED
 *                      ↓             ↓              ↓
 *                    ERROR ←---------┴--------------┘
 *
 * Features:
 * - Persistent TCP socket with automatic reconnection capability
 * - Message framing using MessageFramer for parsing TCP stream
 * - Request-response correlation via sequence IDs
 * - Idle timeout with graceful transition to IDLE_PENDING
 * - In-flight request tracking with timeout handling
 */
export class PeerConnection {
    private socket: Socket | null = null
    private framer: MessageFramer = new MessageFramer()
    private state: ConnectionState = "UNINITIALIZED"
    private peerIdentity: string
    private connectionString: string
    private parsedConnection: ParsedConnectionString | null = null

    // Request tracking
    private inFlightRequests: Map<number, PendingRequest> = new Map()
    private nextSequence = 1

    // Timing and lifecycle
    private idleTimer: NodeJS.Timeout | null = null
    private idleTimeout: number = 10 * 60 * 1000 // 10 minutes default
    private connectTimeout = 5000 // 5 seconds
    private authTimeout = 5000 // 5 seconds
    private connectedAt: number | null = null
    private lastActivity: number = Date.now()

    constructor(peerIdentity: string, connectionString: string) {
        this.peerIdentity = peerIdentity
        this.connectionString = connectionString
    }

    /**
     * Establish TCP connection to peer
     * @param options Connection options (timeout, retries)
     * @returns Promise that resolves when connection is READY
     */
    async connect(options: ConnectionOptions = {}): Promise<void> {
        if (this.state !== "UNINITIALIZED" && this.state !== "CLOSED") {
            throw new Error(
                `Cannot connect from state ${this.state}, must be UNINITIALIZED or CLOSED`,
            )
        }

        this.parsedConnection = parseConnectionString(this.connectionString)
        this.setState("CONNECTING")

        return new Promise((resolve, reject) => {
            const timeout = options.timeout ?? this.connectTimeout

            const timeoutTimer = setTimeout(() => {
                this.socket?.destroy()
                this.setState("ERROR")
                reject(
                    new ConnectionTimeoutError(
                        `Connection timeout after ${timeout}ms`,
                    ),
                )
            }, timeout)

            this.socket = new Socket()

            // Setup socket event handlers
            this.socket.on("connect", () => {
                clearTimeout(timeoutTimer)
                this.connectedAt = Date.now()
                this.resetIdleTimer()

                // Move to AUTHENTICATING state
                // Wave 8.1: Skip authentication for now, will be added in Wave 8.3
                this.setState("READY")
                resolve()
            })

            this.socket.on("data", (chunk: Buffer) => {
                this.handleIncomingData(chunk)
            })

            this.socket.on("error", (error: Error) => {
                clearTimeout(timeoutTimer)
                this.setState("ERROR")
                reject(error)
            })

            this.socket.on("close", () => {
                this.handleSocketClose()
            })

            // Initiate connection
            this.socket.connect(
                this.parsedConnection!.port,
                this.parsedConnection!.host,
            )
        })
    }

    /**
     * Send request and await response (request-response pattern)
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
        if (this.state !== "READY") {
            throw new Error(
                `Cannot send message in state ${this.state}, must be READY`,
            )
        }

        const sequence = this.nextSequence++
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
            this.socket!.write(messageBuffer)

            this.lastActivity = Date.now()
            this.resetIdleTimer()
        })
    }

    /**
     * Send authenticated request and await response
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
        if (this.state !== "READY") {
            throw new Error(
                `Cannot send message in state ${this.state}, must be READY`,
            )
        }

        const sequence = this.nextSequence++
        const timeout = options.timeout ?? 30000 // 30 second default
        const timestamp = Date.now()

        // Build data to sign: Message ID + SHA256(Payload)
        const msgIdBuf = Buffer.allocUnsafe(4)
        msgIdBuf.writeUInt32BE(sequence)
        const payloadHash = Buffer.from(sha256(payload))
        const dataToSign = Buffer.concat([msgIdBuf, payloadHash])

        // Sign with Ed25519
        let signature: Uint8Array
        try {
            signature = await ed25519.sign(dataToSign, privateKey)
        } catch (error) {
            throw new SigningError(
                `Ed25519 signing failed (privateKey length: ${privateKey.length} bytes): ${error instanceof Error ? error.message : error}`,
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

            const messageBuffer = MessageFramer.encodeMessage(header, payload, auth)
            this.socket!.write(messageBuffer)

            this.lastActivity = Date.now()
            this.resetIdleTimer()
        })
    }

    /**
     * Send one-way message (fire-and-forget, no response expected)
     * @param opcode OmniProtocol opcode
     * @param payload Message payload
     */
    sendOneWay(opcode: number, payload: Buffer): void {
        if (this.state !== "READY") {
            throw new Error(
                `Cannot send message in state ${this.state}, must be READY`,
            )
        }

        const sequence = this.nextSequence++

        const header: OmniMessageHeader = {
            version: 1,
            opcode,
            sequence,
            payloadLength: payload.length,
        }

        const messageBuffer = MessageFramer.encodeMessage(header, payload)
        this.socket!.write(messageBuffer)

        this.lastActivity = Date.now()
        this.resetIdleTimer()
    }

    /**
     * Gracefully close the connection
     * Sends proto_disconnect (0xF4) before closing socket
     */
    async close(): Promise<void> {
        if (this.state === "CLOSED" || this.state === "CLOSING") {
            return
        }

        this.setState("CLOSING")

        // Clear idle timer
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
            this.idleTimer = null
        }

        // Reject all pending requests
        for (const [sequence, pending] of this.inFlightRequests) {
            clearTimeout(pending.timer)
            pending.reject(new Error("Connection closing"))
        }
        this.inFlightRequests.clear()

        // Send proto_disconnect (0xF4) if socket is available
        if (this.socket) {
            try {
                this.sendOneWay(0xf4, Buffer.alloc(0)) // 0xF4 = proto_disconnect
            } catch {
                // Ignore errors during disconnect
            }
        }

        // Close socket
        return new Promise((resolve) => {
            if (this.socket) {
                this.socket.once("close", () => {
                    this.setState("CLOSED")
                    resolve()
                })
                this.socket.end()
            } else {
                this.setState("CLOSED")
                resolve()
            }
        })
    }

    /**
     * Get current connection state
     */
    getState(): ConnectionState {
        return this.state
    }

    /**
     * Get connection information for monitoring
     */
    getInfo(): ConnectionInfo {
        return {
            peerIdentity: this.peerIdentity,
            connectionString: this.connectionString,
            state: this.state,
            connectedAt: this.connectedAt,
            lastActivity: this.lastActivity,
            inFlightCount: this.inFlightRequests.size,
        }
    }

    /**
     * Check if connection is ready for requests
     */
    isReady(): boolean {
        return this.state === "READY"
    }

    /**
     * Handle incoming TCP data
     * @private
     */
    private handleIncomingData(chunk: Buffer): void {
        this.lastActivity = Date.now()
        this.resetIdleTimer()

        // Add data to framer
        this.framer.addData(chunk)

        // Extract all complete messages
        let message = this.framer.extractMessage()
        while (message) {
            this.handleMessage(message.header, message.payload)
            message = this.framer.extractMessage()
        }
    }

    /**
     * Handle a complete decoded message
     * @private
     */
    private handleMessage(header: OmniMessageHeader, payload: Buffer): void {
        // Check if this is a response to a pending request
        const pending = this.inFlightRequests.get(header.sequence)

        if (pending) {
            // This is a response - resolve the pending request
            clearTimeout(pending.timer)
            this.inFlightRequests.delete(header.sequence)
            pending.resolve(payload)
        } else {
            // This is an unsolicited message (e.g., broadcast, push notification)
            // Wave 8.1: Log for now, will handle in Wave 8.4 (push message support)
            console.warn(
                `[PeerConnection] Received unsolicited message: opcode=0x${header.opcode.toString(16)}, sequence=${header.sequence}`,
            )
        }
    }

    /**
     * Handle socket close event
     * @private
     */
    private handleSocketClose(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
            this.idleTimer = null
        }

        // Reject all pending requests
        for (const [sequence, pending] of this.inFlightRequests) {
            clearTimeout(pending.timer)
            pending.reject(new Error("Connection closed"))
        }
        this.inFlightRequests.clear()

        if (this.state !== "CLOSING" && this.state !== "CLOSED") {
            this.setState("CLOSED")
        }
    }

    /**
     * Reset idle timeout timer
     * @private
     */
    private resetIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
        }

        this.idleTimer = setTimeout(() => {
            if (this.state === "READY" && this.inFlightRequests.size === 0) {
                this.setState("IDLE_PENDING")
                // Wave 8.2: ConnectionPool will close idle connections
                // For now, just transition state
            }
        }, this.idleTimeout)
    }

    /**
     * Transition to new state
     * @private
     */
    private setState(newState: ConnectionState): void {
        const oldState = this.state
        this.state = newState

        // Wave 8.4: Emit state change events for ConnectionPool to monitor
        // For now, just log
        if (oldState !== newState) {
            console.debug(
                `[PeerConnection] ${this.peerIdentity} state: ${oldState} → ${newState}`,
            )
        }
    }
}
