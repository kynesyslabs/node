// TODO Once tested, implement blockchain registration for the data we want to store (or the hashes of the data)
// TODO Implement handle@[first_2_chars_of_signing_public_key][mid_2_chars_of_signing_public_key][last_2_chars_of_signing_public_key] as handle and give it back to the peer
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
import { ImPeer } from "./ImPeers"
import { ImErrorType } from "./types/Errors"
import {
    ImBaseMessage,
    ImRegisterMessage,
    ImDiscoverMessage,
    ImPeerMessage,
    ImPublicKeyRequestMessage,
} from "./types/IMMessage"
import Transaction from "@/libs/blockchain/transaction"
import {
    signedObject,
    SerializedSignedObject,
    SerializedEncryptedObject,
    ucrypto,
} from "@kynesyslabs/demosdk/encryption"


import { deserializeUint8Array } from "@kynesyslabs/demosdk/utils" // FIXME Import from the sdk once we can
import log from "@/utilities/logger"
/**
 * SignalingServer class that manages peer connections and message routing
 */
export class SignalingServer {
    /** Map of connected peers, keyed by their client IDs */
    private peers: Map<string, ImPeer> = new Map()
    private server: Server

    /**
     * Creates a new signaling server instance
     * @param port - Port number to listen on (default: 3000)
     */
    constructor(port = 3005) {
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

        log.info(`Signaling server running on port ${port}`)
    }

    /**
     * Sends an error message to a WebSocket connection
     * @param ws - The WebSocket to send the error to
     * @param errorType - The type of error that occurred
     * @param details - Additional error details
     */
    private sendError(ws: WebSocket, errorType: ImErrorType, details?: string) {
        log.debug("[IM] Sending an error message: ", errorType, details)
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
        log.info("New peer connected")
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
                log.info(`Peer ${id} disconnected`)
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
            const data: ImBaseMessage = JSON.parse(message)
            //console.log("[IM] Received a message: ", data)
            // Validate message format
            if (!data.type || !data.payload) {
                this.sendError(
                    ws,
                    ImErrorType.INVALID_MESSAGE,
                    "Invalid message format",
                )
                return
            }

            // Check if any response handlers can handle this message
            for (const handler of this.responseHandlers) {
                handler(ws, message)
            }

            switch (data.type) {
                case "register":
                    log.debug("[IM] Received a register message")
                    // Validate the message schema
                    log.debug(data)
                    var registerMessage: ImRegisterMessage =
                        data as ImRegisterMessage
                    if (
                        registerMessage.type !== "register" ||
                        !registerMessage.payload.clientId ||
                        !registerMessage.payload.publicKey ||
                        !registerMessage.payload.verification
                    ) {
                        this.sendError(
                            ws,
                            ImErrorType.INVALID_MESSAGE,
                            "Invalid message schema",
                        )
                    }
                    log.debug("[IM] Register message validated")
                    // Once we have the data, we can use it
                    this.handleRegister(
                        ws,
                        registerMessage.payload.clientId,
                        registerMessage.payload.publicKey,
                        registerMessage.payload.verification,
                    ) // REVIEW As this is async, is ok not to await it?
                    log.debug("[IM] Register message handled")
                    break
                case "discover":
                    this.handleDiscover(ws)
                    break
                case "message":
                    if (!data.payload.targetId || !data.payload.message) {
                        this.sendError(
                            ws,
                            ImErrorType.INVALID_MESSAGE,
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
                            ImErrorType.INVALID_MESSAGE,
                            "Missing target ID",
                        )
                        return
                    }
                    this.handlePublicKeyRequest(ws, data.payload.targetId)
                    break
                case "debug_question": {
                    // Handle debug message to trigger a question
                    log.debug("[IM] Received debug question request")
                    const senderId = this.getPeerIdByWebSocket(ws)
                    if (!senderId) {
                        this.sendError(
                            ws,
                            ImErrorType.REGISTRATION_REQUIRED,
                            "You must register before sending debug messages",
                        )
                        return
                    }
                    // Send a question to the peer
                    this.sendQuestionToPeer(senderId, {
                        text: "This is a debug question. What is your favorite programming language?",
                    })
                    break
                }
                default:
                    this.sendError(
                        ws,
                        ImErrorType.INVALID_MESSAGE,
                        `Unknown message type: ${data.type}`,
                    )
            }
        } catch (error) {
            log.error("Error handling message:", error)
            this.sendError(
                ws,
                ImErrorType.INTERNAL_ERROR,
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
    private async handleRegister(
        ws: WebSocket,
        clientId: string,
        publicKey: Uint8Array,
        proof: SerializedSignedObject,
    ) {
        try {
            if (this.peers.has(clientId)) {
                this.sendError(
                    ws,
                    ImErrorType.CLIENT_ID_TAKEN,
                    `Client ID ${clientId} is already taken`,
                )
                return
            }

            // Validate public key format
            // Transform the public key to a Uint8Array
            var publicKeyUint8Array = new Uint8Array(publicKey)
            log.debug("[IM] Public key: ", publicKey)
            if (publicKeyUint8Array.length === 0) {
                this.sendError(
                    ws,
                    ImErrorType.INVALID_PUBLIC_KEY,
                    "Invalid public key format",
                )
                return
            }

            // Deserialize the proof
            const deserializedProof: signedObject = {
                algorithm: proof.algorithm,
                signedData: deserializeUint8Array(proof.serializedSignedData),
                publicKey: deserializeUint8Array(proof.serializedPublicKey),
                message: deserializeUint8Array(proof.serializedMessage),
            }

            const signingPublicKey = deserializedProof.publicKey

            // Validate the proof
            const verified = await ucrypto.verify(deserializedProof)

            if (!verified) {
                this.sendError(ws, ImErrorType.INVALID_PROOF, "Invalid proof")
                return
            }
            this.peers.set(clientId, {
                id: clientId,
                ws,
                publicKey,
                signingPublicKey,
            })
            log.info(`Peer registered with ID: ${clientId}`)

            // Send confirmation to the registering peer
            ws.send(
                JSON.stringify({
                    type: "register",
                    payload: { success: true, clientId },
                }),
            )
        } catch (error) {
            log.error("Registration error:", error)
            this.sendError(
                ws,
                ImErrorType.INTERNAL_ERROR,
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
            log.error("Discovery error:", error)
            this.sendError(
                ws,
                ImErrorType.INTERNAL_ERROR,
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
            message: SerializedEncryptedObject
        },
    ) {
        // FIXME Adjust the TODOs below
        // TODO Insert the message into the blockchain through the sdk and the node running on this same server
        // TODO Implement support for offline messages (store them in a database and allow the peer to retrieve them later)
        try {
            const senderId = this.getPeerIdByWebSocket(ws)
            if (!senderId) {
                this.sendError(
                    ws,
                    ImErrorType.REGISTRATION_REQUIRED,
                    "You must register before sending messages",
                )
                return
            }

            const targetPeer = this.peers.get(payload.targetId)
            if (!targetPeer) {
                this.sendError(
                    ws,
                    ImErrorType.PEER_NOT_FOUND,
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
            log.error("Message routing error:", error)
            this.sendError(
                ws,
                ImErrorType.INTERNAL_ERROR,
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
                    ImErrorType.PEER_NOT_FOUND,
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
            log.error("Public key request error:", error)
            this.sendError(
                ws,
                ImErrorType.INTERNAL_ERROR,
                "Failed to retrieve public key",
            )
        }
    }

    /**
     * Sends a question to a specific peer
     * @param peerId - The ID of the peer to send the question to
     * @param question - The question to send
     */
    private sendQuestionToPeer(peerId: string, question: any): void {
        try {
            const peer = this.peers.get(peerId)
            if (!peer) {
                log.error(`Target peer ${peerId} not found`)
                return
            }

            const questionId = crypto.randomUUID()

            // Send the question to the peer
            peer.ws.send(
                JSON.stringify({
                    type: "server_question",
                    payload: {
                        questionId,
                        question,
                    },
                }),
            )

            log.debug(`Question sent to peer ${peerId} with ID ${questionId}`)
        } catch (error) {
            log.error("Error sending question to peer:", error)
        }
    }

    // Temporary storage for response handlers
    private responseHandlers: Set<(ws: WebSocket, message: string) => void> =
        new Set()

    // Add a response handler
    private addResponseHandler(
        handler: (ws: WebSocket, message: string) => void,
    ): void {
        this.responseHandlers.add(handler)
    }

    // Remove a response handler
    private removeResponseHandler(
        handler: (ws: WebSocket, message: string) => void,
    ): void {
        this.responseHandlers.delete(handler)
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
            log.error("Broadcast error:", error)
            // Don't send error here as the peer is already disconnected
        }
    }

    /**
     * Disconnects the server and cleans up resources
     */
    public disconnect(): void {
        // Close all peer connections
        for (const peer of this.peers.values()) {
            try {
                peer.ws.close()
            } catch (error) {
                log.error("Error closing peer connection:", error)
            }
        }

        // Clear the peers map
        this.peers.clear()

        // Stop the server
        this.server.stop()

        log.info("Signaling server disconnected")
    }
}

// Create and start the signaling server if this file is run directly
if (import.meta.main) {
    const signalingServer = new SignalingServer(3005)
}
