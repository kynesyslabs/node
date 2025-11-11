import { Socket } from "net"
import { EventEmitter } from "events"
import { MessageFramer } from "../transport/MessageFramer"
import { dispatchOmniMessage } from "../protocol/dispatcher"
import { OmniMessageHeader, ParsedOmniMessage } from "../types/message"

export type ConnectionState =
    | "PENDING_AUTH"      // Waiting for hello_peer
    | "AUTHENTICATED"     // hello_peer succeeded
    | "IDLE"              // No activity
    | "CLOSING"           // Graceful shutdown
    | "CLOSED"            // Fully closed

export interface InboundConnectionConfig {
    authTimeout: number
    connectionTimeout: number
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

    private peerIdentity: string | null = null
    private createdAt: number = Date.now()
    private lastActivity: number = Date.now()
    private authTimer: NodeJS.Timeout | null = null

    constructor(
        socket: Socket,
        connectionId: string,
        config: InboundConnectionConfig
    ) {
        super()
        this.socket = socket
        this.connectionId = connectionId
        this.config = config
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
                    `[InboundConnection] ${this.connectionId} authentication timeout`
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
        console.log(
            `[InboundConnection] ${this.connectionId} received opcode 0x${message.header.opcode.toString(16)}`
        )

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

            // If this was hello_peer and succeeded, mark as authenticated
            if (message.header.opcode === 0x01 && this.state === "PENDING_AUTH") {
                // Extract peer identity from auth block
                if (message.auth && message.auth.identity) {
                    this.peerIdentity = message.auth.identity.toString("hex")
                    this.state = "AUTHENTICATED"

                    if (this.authTimer) {
                        clearTimeout(this.authTimer)
                        this.authTimer = null
                    }

                    this.emit("authenticated", this.peerIdentity)
                    console.log(
                        `[InboundConnection] ${this.connectionId} authenticated as ${this.peerIdentity}`
                    )
                }
            }
        } catch (error) {
            console.error(
                `[InboundConnection] ${this.connectionId} handler error:`,
                error
            )

            // Send error response
            const errorPayload = Buffer.from(
                JSON.stringify({
                    error: String(error),
                })
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
                        error
                    )
                    reject(error)
                } else {
                    resolve()
                }
            })
        })
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
