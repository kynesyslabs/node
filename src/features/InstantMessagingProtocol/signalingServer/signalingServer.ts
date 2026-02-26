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
import { Mutex } from "async-mutex"
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
import Chain from "@/libs/blockchain/chain"
import {
    signedObject,
    SerializedSignedObject,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import Mempool from "@/libs/blockchain/mempool_v2"

import type { SerializedEncryptedObject } from "@kynesyslabs/demosdk/types"
import Hashing from "@/libs/crypto/hashing"
import { getSharedState } from "@/utilities/sharedState"
import Datasource from "@/model/datasource"
import { OfflineMessage } from "@/model/entities/OfflineMessages"

import { deserializeUint8Array } from "@kynesyslabs/demosdk/utils" // FIXME Import from the sdk once we can
import log from "@/utilities/logger"
/**
 * SignalingServer class that manages peer connections and message routing
 */
export class SignalingServer {
    /** Map of connected peers, keyed by their client IDs */
    private peers: Map<string, ImPeer> = new Map()
    private server: Server
    /** Per-sender nonce counter for transaction uniqueness and replay prevention */
    private readonly senderNonces: Map<string, number> = new Map()
    /** Mutex to protect senderNonces from race conditions */
    // REVIEW: PR Fix #2 - Add mutex for thread-safe nonce management
    private readonly nonceMutex: Mutex = new Mutex()
    /** Basic DoS protection: track offline message count per sender (reset on successful delivery) */
    private readonly offlineMessageCounts: Map<string, number> = new Map()
    /** Mutex to protect offlineMessageCounts from race conditions */
    // REVIEW: PR Fix #2 - Add mutex for thread-safe count management
    private readonly countMutex: Mutex = new Mutex()
    private readonly MAX_OFFLINE_MESSAGES_PER_SENDER = 100

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
        log.debug(`[IM] Sending an error message: ${errorType}${details ? ` - ${details}` : ""}`)
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
    private async handleMessage(ws: WebSocket, message: string) {
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
                case "register": {
                    log.debug("[IM] Received a register message")
                    // Validate the message schema
                    log.debug(data)
                    let registerMessage: ImRegisterMessage =
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
                }
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
                    // REVIEW: PR Fix - Await async method to catch errors
                    await this.handlePeerMessage(ws, data.payload)
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
            const publicKeyUint8Array = new Uint8Array(publicKey)
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
                signature: deserializeUint8Array(proof.serializedSignedData),
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

            // Deliver any offline messages to the newly registered peer
            await this.deliverOfflineMessages(ws, clientId)
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
    private async handlePeerMessage(
        ws: WebSocket,
        payload: {
            targetId: string
            message: SerializedEncryptedObject
        },
    ) {
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

            // Check if target peer exists BEFORE blockchain write (prevent DoS)
            const targetPeer = this.peers.get(payload.targetId)

            if (!targetPeer) {
                // Store as offline message if target is not online
                // REVIEW: PR Fix #3 #5 - Store to database first (easier to rollback), then blockchain (best-effort)
                // REVIEW: PR Fix #2 - Removed redundant rate limit check; storeOfflineMessage has authoritative check with mutex
                let messageId: string
                try {
                    // @ts-ignore - We know this returns a string ID now
                    messageId = await this.storeOfflineMessage(senderId, payload.targetId, payload.message) as unknown as string
                } catch (error: any) {
                    console.error("Failed to store offline message in DB:", error)
                    // REVIEW: PR Fix #2 - Provide specific error message for rate limit
                    if (error.message?.includes("exceeded offline message limit")) {
                        this.sendError(
                            ws,
                            ImErrorType.INTERNAL_ERROR,
                            `Offline message limit reached (${this.MAX_OFFLINE_MESSAGES_PER_SENDER} messages). Please wait for recipient to come online.`,
                        )
                    } else {
                        this.sendError(ws, ImErrorType.INTERNAL_ERROR, "Failed to store offline message")
                    }
                    return
                }

                // REVIEW: PR Fix - CodeRabbit Issue #1 - Make blockchain storage mandatory for audit trail consistency
                // Then store to blockchain (mandatory for audit trail consistency with online path)
                try {
                    await this.storeMessageOnBlockchain(senderId, payload.targetId, payload.message)
                } catch (error) {
                    console.error("Failed to store message on blockchain:", error)
                    // Rollback DB storage
                    if (messageId) {
                        await this.rollbackOfflineMessage(messageId, senderId)
                    }
                    this.sendError(ws, ImErrorType.INTERNAL_ERROR, "Failed to store offline message")
                    return  // Abort on blockchain failure for audit trail consistency
                }
                // REVIEW: PR Fix #11 - Use proper success message instead of error for offline storage
                ws.send(JSON.stringify({
                    type: "message_queued",
                    payload: {
                        targetId: payload.targetId,
                        status: "offline",
                        message: "Message stored for offline delivery",
                    },
                }))
                return
            }

            // REVIEW: PR Fix #5 - Make blockchain storage mandatory for online path consistency
            // Create blockchain transaction for online message
            try {
                await this.storeMessageOnBlockchain(senderId, payload.targetId, payload.message)
            } catch (error) {
                console.error("Failed to store message on blockchain:", error)
                this.sendError(ws, ImErrorType.INTERNAL_ERROR, "Failed to store message")
                return  // Abort on blockchain failure for audit trail consistency
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
     * Stores a message on the blockchain
     *
     * REVIEW: PR Fix #6 - Authentication Architecture
     *
     * Current Implementation: Node Signing
     * - Node signs transactions with its own private key
     * - Provides: Tamper detection, integrity verification
     * - Limitations: No sender authentication, no non-repudiation
     *
     * Recommended Implementation: Sender Signing
     * - Clients sign messages with their private key before sending
     * - Server verifies sender signature instead of creating one
     * - Provides: True authentication, non-repudiation, sender accountability
     *
     * Migration Path:
     * 1. Add 'signature' field to ImPeerMessage payload (types/IMMessage.ts)
     * 2. Update client SDK to sign messages before sending
     * 3. Add signature verification in handlePeerMessage()
     * 4. Deprecate node signing in favor of verified sender signatures
     *
     * @param senderId - The ID of the sender
     * @param targetId - The ID of the target recipient
     * @param message - The encrypted message content
     */
    private async storeMessageOnBlockchain(senderId: string, targetId: string, message: SerializedEncryptedObject) {
        // REVIEW: PR Fix #2 - Use mutex to prevent nonce race conditions
        // Acquire lock before reading/modifying nonce to ensure atomic operation
        return await this.nonceMutex.runExclusive(async () => {
            const signerPublicKeyHex = getSharedState.publicKeyHex
            if (!signerPublicKeyHex) {
                throw new Error("[Signaling Server] Node public key not available for message signing")
            }

            // REVIEW: PR Fix #6 - Nonce must be coherent for the actual signer (`from`)
            const currentNonce = this.senderNonces.get(signerPublicKeyHex) || 0
            const nonce = currentNonce + 1
            // Don't increment yet - wait for mempool success for better error handling

            const transaction = new Transaction()
            const now = Date.now()
            transaction.content = {
                type: "instantMessaging",
                from: signerPublicKeyHex,
                to: targetId,
                from_ed25519_address: signerPublicKeyHex,
                amount: 0,
                data: ["instantMessaging", { senderId, targetId, message, timestamp: now }] as any,
                gcr_edits: [],
                nonce,
                timestamp: now,
                transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0 },
            }

            transaction.hash = Hashing.sha256(JSON.stringify(transaction.content))
            const signature = await ucrypto.sign(
                getSharedState.signingAlgorithm,
                new TextEncoder().encode(transaction.hash),
            )
            transaction.signature = {
                type: getSharedState.signingAlgorithm,
                data: uint8ArrayToHex(signature.signature),
            }

            // Add to mempool
            // REVIEW: PR Fix #13 - Add error handling for blockchain storage consistency
            try {
                const referenceBlock = await Chain.getLastBlockNumber()
                await Mempool.addTransaction({
                    ...transaction,
                    reference_block: referenceBlock,
                })
                // REVIEW: PR Fix #6 - Only increment nonce after successful mempool addition
                this.senderNonces.set(signerPublicKeyHex, nonce)
            } catch (error: any) {
                console.error("[Signaling Server] Failed to add message transaction to mempool:", error.message)
                throw error // Rethrow to be caught by caller's error handling
            }
        })
    }

    /**
     * Stores a message in the database for offline delivery
     *
     * REVIEW: PR Fix #6 - Same authentication architecture issue as storeMessageOnBlockchain()
     * See storeMessageOnBlockchain() documentation for full details on recommended sender signing approach.
     *
     * @param senderId - The ID of the sender
     * @param targetId - The ID of the target recipient
     * @param message - The encrypted message content
     */
    private async storeOfflineMessage(senderId: string, targetId: string, message: SerializedEncryptedObject) {
        // REVIEW: PR Fix #2 - Use mutex to prevent rate limit bypass via race conditions
        // Acquire lock before checking/modifying count to ensure atomic operation
        return await this.countMutex.runExclusive(async () => {
            // REVIEW: PR Fix #9 - Defensive rate limiting check (in case method is called from other locations)
            const currentCount = this.offlineMessageCounts.get(senderId) || 0
            if (currentCount >= this.MAX_OFFLINE_MESSAGES_PER_SENDER) {
                throw new Error(`Sender ${senderId} has exceeded offline message limit (${this.MAX_OFFLINE_MESSAGES_PER_SENDER})`)
            }

            const db = await Datasource.getInstance()
            const offlineMessageRepository = db.getDataSource().getRepository(OfflineMessage)

            // REVIEW: PR Fix - Use deterministic key ordering for consistent hashing
            const timestamp = Date.now()
            const messageContent = JSON.stringify({
                message,      // Keys in alphabetical order
                senderId,
                targetId,
                timestamp,
            })
            const messageHash = Hashing.sha256(messageContent)

            const signature = await ucrypto.sign(
                getSharedState.signingAlgorithm,
                new TextEncoder().encode(messageHash),
            )

            const offlineMessage = offlineMessageRepository.create({
                recipientPublicKey: targetId,
                senderPublicKey: senderId,
                messageHash,
                encryptedContent: message,
                signature: Buffer.from(signature.signature).toString("base64"),
                // REVIEW: PR Fix #9 - timestamp is string type to match TypeORM bigint behavior
                timestamp: Date.now().toString(),
                status: "pending",
            })

            await offlineMessageRepository.save(offlineMessage)

            // REVIEW: PR Fix #9 - Increment count after successful save
            this.offlineMessageCounts.set(senderId, currentCount + 1)

            return offlineMessage.id
        })
    }

    /**
     * Rolls back an offline message storage operation (used when blockchain write fails)
     * @param messageId - The ID of the message to delete
     * @param senderId - The ID of the sender to decrement count for
     */
    private async rollbackOfflineMessage(messageId: string, senderId: string) {
        await this.countMutex.runExclusive(async () => {
            try {
                const db = await Datasource.getInstance()
                const offlineMessageRepository = db.getDataSource().getRepository(OfflineMessage)
                await offlineMessageRepository.delete(messageId)

                const currentCount = this.offlineMessageCounts.get(senderId) || 0
                this.offlineMessageCounts.set(senderId, Math.max(0, currentCount - 1))
                if (this.offlineMessageCounts.get(senderId) === 0) {
                    this.offlineMessageCounts.delete(senderId)
                }
                log.debug(`[Signaling Server] Rolled back offline message ${messageId} for sender ${senderId}`)
            } catch (error) {
                log.error(`[Signaling Server] Failed to rollback offline message ${messageId}:`, error)
            }
        })
    }

    /**
     * Retrieves offline messages for a specific recipient
     * @param recipientId - The ID of the recipient
     * @returns Array of offline messages
     */
    private async getOfflineMessages(recipientId: string): Promise<OfflineMessage[]> {
        const db = await Datasource.getInstance()
        const offlineMessageRepository = db.getDataSource().getRepository(OfflineMessage)

        // REVIEW: PR Fix #10 - Add chronological ordering for message delivery
        return await offlineMessageRepository.find({
            where: { recipientPublicKey: recipientId, status: "pending" },
            order: { timestamp: "ASC" },
        })
    }

    /**
     * Delivers offline messages to a peer when they come online
     *
     * REVIEW: PR Fix #6 - Transactional message delivery with error handling
     * Only marks messages as delivered after successful WebSocket send to prevent message loss
     * Breaks on first failure to maintain message ordering and prevent partial delivery
     *
     * @param ws - The WebSocket connection of the peer
     * @param peerId - The ID of the peer
     */
    private async deliverOfflineMessages(ws: WebSocket, peerId: string) {
        const offlineMessages = await this.getOfflineMessages(peerId)

        // Get DB/repository once before loop for better performance
        const db = await Datasource.getInstance()
        const offlineMessageRepository = db.getDataSource().getRepository(OfflineMessage)

        let sentCount = 0
        const senderCounts = new Map<string, number>()

        for (const msg of offlineMessages) {
            // REVIEW: PR Fix #7 - Check WebSocket readyState before sending to prevent silent failures
            if (ws.readyState !== WebSocket.OPEN) {
                console.log(`WebSocket not open for ${peerId}, stopping delivery`)
                break
            }

            try {
                // Attempt to send message via WebSocket
                ws.send(JSON.stringify({
                    type: "message",
                    payload: {
                        message: msg.encryptedContent,
                        fromId: msg.senderPublicKey,
                        timestamp: Number(msg.timestamp),
                    },
                }))

                // REVIEW: PR Fix #7 #10 - Mark as "sent" (not "delivered") since WebSocket.send() doesn't guarantee receipt
                if (ws.readyState === WebSocket.OPEN) {
                    await offlineMessageRepository.update(msg.id, { status: "sent" })
                    sentCount++

                    // Track sent messages per sender for rate limit reset
                    const currentCount = senderCounts.get(msg.senderPublicKey) || 0
                    senderCounts.set(msg.senderPublicKey, currentCount + 1)
                }

            } catch (error) {
                // WebSocket send failed - stop delivery to prevent out-of-order messages
                console.error(`Failed to deliver offline message ${msg.id} to ${peerId}:`, error)
                // Break on first failure to maintain message ordering
                // Undelivered messages will be retried when peer reconnects
                break
            }
        }

        // REVIEW: PR Fix #9 - Reset offline message counts for senders after successful delivery
        if (sentCount > 0) {
            // REVIEW: PR Fix #2 - Use mutex to prevent lost updates during concurrent deliveries
            for (const [senderId, count] of senderCounts.entries()) {
                await this.countMutex.runExclusive(async () => {
                    const currentCount = this.offlineMessageCounts.get(senderId) || 0
                    const newCount = Math.max(0, currentCount - count)
                    if (newCount === 0) {
                        this.offlineMessageCounts.delete(senderId)
                    } else {
                        this.offlineMessageCounts.set(senderId, newCount)
                    }
                })
            }
            console.log(`Sent ${sentCount} offline messages to ${peerId}`)
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
