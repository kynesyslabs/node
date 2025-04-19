// TODO Once tested, implement blockchain registration for the data we want to store (or the hashes of the data)
// FIXME Offline messaging is not implemented, we need to implement it by storing messages in a database if the peer is offline
// REVIEW Probably need to implement a way to verify the public key of the peer for retrieval purposes (e.g. offline messages)
/**
 * Signaling Server Implementation
 *
 * This module implements a WebSocket-based signaling server that facilitates peer-to-peer
 * communication between multiple clients. The server acts as a central hub for peer
 * discovery and message routing, enabling direct communication between peers.
 *
 * Key Features:
 * - Peer registration with unique client IDs
 * - Peer discovery service
 * - Direct message routing between peers
 * - Automatic peer disconnection handling
 * - Real-time peer status updates
 * - Public key exchange for secure communication
 * - Comprehensive error handling
 *
 * Usage:
 * 1. Start the server:
 *    - Run this file directly: `bun run signalingServer.ts`
 *    - Or import and instantiate: `new SignalingServer(port)`
 *
 * 2. Client Connection Flow:
 *    a. Connect to WebSocket server
 *    b. Register with unique client ID and public key
 *    c. Discover other peers
 *    d. Request peer public keys as needed
 *    e. Send/receive messages to/from specific peers
 *
 * Message Types:
 * - register: Register a new peer with a client ID and public key
 * - discover: Get list of all connected peers
 * - message: Send a message to a specific peer
 * - peer_disconnected: Notification when a peer disconnects
 * - request_public_key: Request a peer's public key
 * - public_key_response: Response containing a peer's public key
 * - error: Error notification with details
 *
 * @module SignalingServer
 */

import { Server } from "bun"

/**
 * Represents a connected peer in the signaling server
 */
interface Peer {
    id: string
    ws: WebSocket
    publicKey: Uint8Array
}

/**
 * Message format for all server-client communication
 */
interface Message {
    type:
        | "register"
        | "discover"
        | "message"
        | "peer_disconnected"
        | "request_public_key"
        | "public_key_response"
        | "error"
    payload: any
}

/**
 * Error types that can occur in the signaling server
 */
enum ErrorType {
    INVALID_MESSAGE = "INVALID_MESSAGE",
    CLIENT_ID_TAKEN = "CLIENT_ID_TAKEN",
    PEER_NOT_FOUND = "PEER_NOT_FOUND",
    INVALID_PUBLIC_KEY = "INVALID_PUBLIC_KEY",
    REGISTRATION_REQUIRED = "REGISTRATION_REQUIRED",
    INTERNAL_ERROR = "INTERNAL_ERROR",
}

/**
 * SignalingServer class that manages peer connections and message routing
 */
class SignalingServer {
    /** Map of connected peers, keyed by their client IDs */
    private peers: Map<string, Peer> = new Map()
    private server: Server

    /**
     * Creates a new signaling server instance
     * @param port - Port number to listen on (default: 3000)
     */
    constructor(port = 3000) {
        this.server = Bun.serve({
            port,
            fetch: (req, server) => {
                if (server.upgrade(req)) {
                    return undefined
                }
                return new Response("Upgrade failed", { status: 500 })
            },
            websocket: {
                message: this.handleMessage.bind(this),
                open: this.handleOpen.bind(this),
                close: this.handleClose.bind(this),
            },
        })

        console.log(`Signaling server running on port ${port}`)
    }

    /**
     * Sends an error message to a WebSocket connection
     * @param ws - The WebSocket to send the error to
     * @param errorType - The type of error that occurred
     * @param details - Additional error details
     */
    private sendError(ws: WebSocket, errorType: ErrorType, details?: string) {
        ws.send(
            JSON.stringify({
                type: "error",
                payload: {
                    errorType,
                    details,
                    timestamp: new Date().toISOString(),
                },
            }),
        )
    }

    /**
     * Handles new WebSocket connections
     * @param ws - The new WebSocket connection
     */
    private handleOpen(ws: WebSocket) {
        console.log("New peer connected")
    }

    /**
     * Handles peer disconnections and cleanup
     * @param ws - The disconnected WebSocket
     */
    private handleClose(ws: WebSocket) {
        // Find and remove the disconnected peer
        for (const [id, peer] of this.peers.entries()) {
            if (peer.ws === ws) {
                this.peers.delete(id)
                this.broadcastPeerDisconnected(id)
                console.log(`Peer ${id} disconnected`)
                break
            }
        }
    }

    /**
     * Main message handler for all incoming WebSocket messages
     * @param ws - The WebSocket that sent the message
     * @param message - The raw message string
     */
    private handleMessage(ws: WebSocket, message: string) {
        try {
            const data: Message = JSON.parse(message)

            // Validate message format
            if (!data.type || !data.payload) {
                this.sendError(
                    ws,
                    ErrorType.INVALID_MESSAGE,
                    "Invalid message format",
                )
                return
            }

            switch (data.type) {
                case "register":
                    if (!data.payload.clientId || !data.payload.publicKey) {
                        this.sendError(
                            ws,
                            ErrorType.INVALID_MESSAGE,
                            "Missing required registration fields",
                        )
                        return
                    }
                    this.handleRegister(
                        ws,
                        data.payload.clientId,
                        data.payload.publicKey,
                    )
                    break
                case "discover":
                    this.handleDiscover(ws)
                    break
                case "message":
                    if (!data.payload.targetId || !data.payload.message) {
                        this.sendError(
                            ws,
                            ErrorType.INVALID_MESSAGE,
                            "Missing required message fields",
                        )
                        return
                    }
                    this.handlePeerMessage(ws, data.payload)
                    break
                case "request_public_key":
                    if (!data.payload.targetId) {
                        this.sendError(
                            ws,
                            ErrorType.INVALID_MESSAGE,
                            "Missing target ID",
                        )
                        return
                    }
                    this.handlePublicKeyRequest(ws, data.payload.targetId)
                    break
                default:
                    this.sendError(
                        ws,
                        ErrorType.INVALID_MESSAGE,
                        `Unknown message type: ${data.type}`,
                    )
            }
        } catch (error) {
            console.error("Error handling message:", error)
            this.sendError(
                ws,
                ErrorType.INTERNAL_ERROR,
                error instanceof Error ? error.message : "Unknown error",
            )
        }
    }

    /**
     * Handles peer registration with a client ID and public key
     * @param ws - The WebSocket connection to register
     * @param clientId - The unique identifier for the peer
     * @param publicKey - The peer's public key as Uint8Array
     */
    private handleRegister(
        ws: WebSocket,
        clientId: string,
        publicKey: Uint8Array,
    ) {
        try {
            if (this.peers.has(clientId)) {
                this.sendError(
                    ws,
                    ErrorType.CLIENT_ID_TAKEN,
                    `Client ID ${clientId} is already taken`,
                )
                return
            }

            // Validate public key format
            if (!(publicKey instanceof Uint8Array) || publicKey.length === 0) {
                this.sendError(
                    ws,
                    ErrorType.INVALID_PUBLIC_KEY,
                    "Invalid public key format",
                )
                return
            }

            this.peers.set(clientId, { id: clientId, ws, publicKey })
            console.log(`Peer registered with ID: ${clientId}`)

            // Send confirmation to the registering peer
            ws.send(
                JSON.stringify({
                    type: "register",
                    payload: { success: true, clientId },
                }),
            )
        } catch (error) {
            console.error("Registration error:", error)
            this.sendError(
                ws,
                ErrorType.INTERNAL_ERROR,
                "Failed to complete registration",
            )
        }
    }

    /**
     * Handles peer discovery requests
     * @param ws - The WebSocket requesting peer discovery
     */
    private handleDiscover(ws: WebSocket) {
        try {
            const peerList = Array.from(this.peers.keys())
            ws.send(
                JSON.stringify({
                    type: "discover",
                    payload: { peers: peerList },
                }),
            )
        } catch (error) {
            console.error("Discovery error:", error)
            this.sendError(
                ws,
                ErrorType.INTERNAL_ERROR,
                "Failed to retrieve peer list",
            )
        }
    }

    /**
     * Handles message routing between peers
     * @param ws - The WebSocket sending the message
     * @param payload - Message payload containing target ID and message content
     */
    private handlePeerMessage(
        ws: WebSocket,
        payload: {
            targetId: string
            message: {
                algorithm: "ml-kem-aes" | "rsa"
                encryptedData: Uint8Array
                cipherText?: Uint8Array
            }
        }, // TODO use encryptedObject once we can import it from the sdk
    ) {
        try {
            const senderId = this.getPeerIdByWebSocket(ws)
            if (!senderId) {
                this.sendError(
                    ws,
                    ErrorType.REGISTRATION_REQUIRED,
                    "You must register before sending messages",
                )
                return
            }

            const targetPeer = this.peers.get(payload.targetId)
            if (!targetPeer) {
                this.sendError(
                    ws,
                    ErrorType.PEER_NOT_FOUND,
                    `Target peer ${payload.targetId} not found`,
                )
                return
            }

            // Forward the message to the target peer
            targetPeer.ws.send(
                JSON.stringify({
                    type: "message",
                    payload: {
                        message: payload.message,
                        fromId: senderId,
                    },
                }),
            )
        } catch (error) {
            console.error("Message routing error:", error)
            this.sendError(
                ws,
                ErrorType.INTERNAL_ERROR,
                "Failed to route message",
            )
        }
    }

    /**
     * Handles requests for a peer's public key
     * @param ws - The WebSocket requesting the public key
     * @param targetId - The ID of the peer whose public key is requested
     */
    private handlePublicKeyRequest(ws: WebSocket, targetId: string) {
        try {
            const targetPeer = this.peers.get(targetId)
            if (!targetPeer) {
                this.sendError(
                    ws,
                    ErrorType.PEER_NOT_FOUND,
                    `Target peer ${targetId} not found`,
                )
                return
            }

            // Send the public key to the requesting peer
            ws.send(
                JSON.stringify({
                    type: "public_key_response",
                    payload: {
                        peerId: targetId,
                        publicKey: Array.from(targetPeer.publicKey),
                    },
                }),
            )
        } catch (error) {
            console.error("Public key request error:", error)
            this.sendError(
                ws,
                ErrorType.INTERNAL_ERROR,
                "Failed to retrieve public key",
            )
        }
    }

    /**
     * Retrieves the peer ID associated with a WebSocket connection
     * @param ws - The WebSocket to look up
     * @returns The peer ID or undefined if not found
     */
    private getPeerIdByWebSocket(ws: WebSocket): string | undefined {
        for (const [id, peer] of this.peers.entries()) {
            if (peer.ws === ws) {
                return id
            }
        }
        return undefined
    }

    /**
     * Broadcasts a peer disconnection event to all connected peers
     * @param disconnectedId - The ID of the disconnected peer
     */
    private broadcastPeerDisconnected(disconnectedId: string) {
        try {
            const message = JSON.stringify({
                type: "peer_disconnected",
                payload: { peerId: disconnectedId },
            })

            for (const peer of this.peers.values()) {
                peer.ws.send(message)
            }
        } catch (error) {
            console.error("Broadcast error:", error)
            // Don't send error here as the peer is already disconnected
        }
    }
}

// Create and start the signaling server if this file is run directly
if (import.meta.main) {
    const signalingServer = new SignalingServer(3000)
}
