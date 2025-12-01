import { Socket } from "net"
import { EventEmitter } from "events"
import { MessageFramer } from "../transport/MessageFramer"
import { dispatchOmniMessage } from "../protocol/dispatcher"
import { OmniMessageHeader, ParsedOmniMessage } from "../types/message"
import { RateLimiter } from "../ratelimit"

export type ConnectionState =
    | "PENDING_AUTH"      // Waiting for hello_peer
    | "AUTHENTICATED"     // hello_peer succeeded
    | "IDLE"              // No activity
    | "CLOSING"           // Graceful shutdown
    | "CLOSED"            // Fully closed

export interface InboundConnectionConfig {
    authTimeout: number
    connectionTimeout: number
    rateLimiter?: RateLimiter
}

/**
 * InboundConnection handles a single inbound connection from a peer
 * Manages message parsing, dispatching, and response sending
 */
export class InboundConnection extends EventEmitter {
    private socket: Socket
    private connectionId: string
    private framer: MessageFramer
    private state: ConnectionState = "PENDING_AUTH"
    private config: InboundConnectionConfig
    private rateLimiter?: RateLimiter

    private peerIdentity: string | null = null
    private createdAt: number = Date.now()
    private lastActivity: number = Date.now()
    private authTimer: NodeJS.Timeout | null = null

    constructor(
        socket: Socket,
        connectionId: string,
        config: InboundConnectionConfig,
    ) {
        super()
        this.socket = socket
        this.connectionId = connectionId
        this.config = config
        this.rateLimiter = config.rateLimiter
        this.framer = new MessageFramer()
    }

    /**
     * Start handling connection
     */
    start(): void {
        console.log(`[InboundConnection] ${this.connectionId} starting`)

        // Setup socket handlers
        this.socket.on("data", (chunk: Buffer) => {
            this.handleIncomingData(chunk)
        })

        this.socket.on("error", (error: Error) => {
            console.error(`[InboundConnection] ${this.connectionId} error:`, error)
            this.emit("error", error)
            this.close()
        })

        this.socket.on("close", () => {
            console.log(`[InboundConnection] ${this.connectionId} socket closed`)
            this.state = "CLOSED"
            this.emit("close")
        })

        // Start authentication timeout
        this.authTimer = setTimeout(() => {
            if (this.state === "PENDING_AUTH") {
                console.warn(
                    `[InboundConnection] ${this.connectionId} authentication timeout`,
                )
                this.close()
            }
        }, this.config.authTimeout)
    }

    /**
     * Handle incoming TCP data
     */
    private async handleIncomingData(chunk: Buffer): Promise<void> {
        this.lastActivity = Date.now()

        // Add to framer
        this.framer.addData(chunk)

        // Extract all complete messages
        let message = this.framer.extractMessage()
        while (message) {
            await this.handleMessage(message)
            message = this.framer.extractMessage()
        }
    }

    /**
     * Handle a complete decoded message
     */
    private async handleMessage(message: ParsedOmniMessage): Promise<void> {
        // REVIEW: Debug logging for peer identity tracking
        console.log(
            `[InboundConnection] ${this.connectionId} received opcode 0x${message.header.opcode.toString(16)}`,
        )
        console.log(
            `[InboundConnection] state=${this.state}, peerIdentity=${this.peerIdentity || "null"}`,
        )
        if (message.auth) {
            console.log(
                `[InboundConnection] auth.identity=${message.auth.identity ? "0x" + message.auth.identity.toString("hex") : "null"}`,
            )
        }

        // REVIEW: Extract peer identity from auth block for ANY authenticated message
        // This allows the connection to be authenticated by any message with valid auth,
        // not just hello_peer (0x01). This is essential for stateless request patterns
        // where clients send authenticated requests without explicit handshake.
        if (message.auth && message.auth.identity && !this.peerIdentity) {
            this.peerIdentity = "0x" + message.auth.identity.toString("hex")
            this.state = "AUTHENTICATED"

            if (this.authTimer) {
                clearTimeout(this.authTimer)
                this.authTimer = null
            }

            this.emit("authenticated", this.peerIdentity)
            console.log(
                `[InboundConnection] ${this.connectionId} authenticated via auth block as ${this.peerIdentity}`,
            )
        }

        // Check rate limits
        if (this.rateLimiter) {
            const ipAddress = this.socket.remoteAddress || "unknown"

            // Check IP-based rate limit
            const ipResult = this.rateLimiter.checkIPRequest(ipAddress)
            if (!ipResult.allowed) {
                console.warn(
                    `[InboundConnection] ${this.connectionId} IP rate limit exceeded: ${ipResult.reason}`,
                )
                // Send error response
                await this.sendErrorResponse(
                    message.header.sequence,
                    0xf429, // Too Many Requests
                    ipResult.reason || "Rate limit exceeded",
                )
                return
            }

            // Check identity-based rate limit (if authenticated)
            if (this.peerIdentity) {
                const identityResult = this.rateLimiter.checkIdentityRequest(this.peerIdentity)
                if (!identityResult.allowed) {
                    console.warn(
                        `[InboundConnection] ${this.connectionId} identity rate limit exceeded: ${identityResult.reason}`,
                    )
                    // Send error response
                    await this.sendErrorResponse(
                        message.header.sequence,
                        0xf429, // Too Many Requests
                        identityResult.reason || "Rate limit exceeded",
                    )
                    return
                }
            }
        }

        try {
            // Dispatch to handler
            const responsePayload = await dispatchOmniMessage({
                message,
                context: {
                    peerIdentity: this.peerIdentity || "unknown",
                    connectionId: this.connectionId,
                    remoteAddress: this.socket.remoteAddress || "unknown",
                    isAuthenticated: this.state === "AUTHENTICATED",
                },
                fallbackToHttp: async () => {
                    throw new Error("HTTP fallback not available on server side")
                },
            })

            // Send response back to client
            await this.sendResponse(message.header.sequence, responsePayload)

            // Note: Authentication is now handled at the top of this method
            // for ANY message with a valid auth block, not just hello_peer
        } catch (error) {
            console.error(
                `[InboundConnection] ${this.connectionId} handler error:`,
                error,
            )

            // Send error response
            const errorPayload = Buffer.from(
                JSON.stringify({
                    error: String(error),
                }),
            )
            await this.sendResponse(message.header.sequence, errorPayload)
        }
    }

    /**
     * Send response message back to client
     */
    private async sendResponse(sequence: number, payload: Buffer): Promise<void> {
        const header: OmniMessageHeader = {
            version: 1,
            opcode: 0xff, // Generic response opcode
            sequence,
            payloadLength: payload.length,
        }

        const messageBuffer = MessageFramer.encodeMessage(header, payload)

        return new Promise((resolve, reject) => {
            this.socket.write(messageBuffer, (error) => {
                if (error) {
                    console.error(
                        `[InboundConnection] ${this.connectionId} write error:`,
                        error,
                    )
                    reject(error)
                } else {
                    resolve()
                }
            })
        })
    }

    /**
     * Send error response
     */
    private async sendErrorResponse(
        sequence: number,
        errorCode: number,
        errorMessage: string,
    ): Promise<void> {
        // Create error payload: 2 bytes error code + error message
        const messageBuffer = Buffer.from(errorMessage, "utf8")
        const payload = Buffer.allocUnsafe(2 + messageBuffer.length)
        payload.writeUInt16BE(errorCode, 0)
        messageBuffer.copy(payload, 2)

        return this.sendResponse(sequence, payload)
    }

    /**
     * Close connection gracefully
     */
    async close(): Promise<void> {
        if (this.state === "CLOSED" || this.state === "CLOSING") {
            return
        }

        this.state = "CLOSING"

        if (this.authTimer) {
            clearTimeout(this.authTimer)
            this.authTimer = null
        }

        return new Promise((resolve) => {
            this.socket.once("close", () => {
                this.state = "CLOSED"
                resolve()
            })
            this.socket.end()
        })
    }

    getState(): ConnectionState {
        return this.state
    }

    getLastActivity(): number {
        return this.lastActivity
    }

    getCreatedAt(): number {
        return this.createdAt
    }

    getPeerIdentity(): string | null {
        return this.peerIdentity
    }
}
