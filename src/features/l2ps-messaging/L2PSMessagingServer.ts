/**
 * L2PSMessagingServer
 *
 * Bun WebSocket server for real-time L2PS-backed messaging.
 * Messages are delivered instantly via WebSocket and persisted through L2PS rollup.
 */

import type { Server, ServerWebSocket } from "bun"
import { ucrypto } from "@kynesyslabs/demosdk/encryption"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"
import { L2PSMessagingService } from "./L2PSMessagingService"
import type {
    ConnectedPeer,
    ProtocolFrame,
    RegisterMessage,
    SendMessage,
    HistoryMessage,
    ErrorCode,
} from "./types"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"

/** Max raw WebSocket message size (256 KB) */
const MAX_MESSAGE_SIZE = 256 * 1024
/** Max encrypted ciphertext size (128 KB base64) */
const MAX_CIPHERTEXT_SIZE = 128 * 1024
/** Min valid hex public key length (ed25519 = 64 hex chars) */
const MIN_PUBLIC_KEY_LENGTH = 64

interface WSData {
    publicKey: string | null
    l2psUid: string | null
}

export class L2PSMessagingServer {
    private peers = new Map<string, ConnectedPeer>()
    private server: Server<WSData>
    private service: L2PSMessagingService

    constructor(port: number) {
        this.service = L2PSMessagingService.getInstance()

        this.server = Bun.serve<WSData>({
            port,
            fetch: (req, server) => {
                if (server.upgrade(req, { data: { publicKey: null, l2psUid: null } })) {
                    return undefined
                }
                return new Response("WebSocket upgrade required", { status: 426 })
            },
            websocket: {
                message: (ws, message) => this.handleMessage(ws, message as string),
                open: (ws) => log.debug("[L2PS-IM] New connection"),
                close: (ws) => this.handleClose(ws),
            },
        })

        log.info(`[L2PS-IM] Messaging server running on port ${port}`)
    }

    stop(): void {
        this.server.stop()
        this.peers.clear()
        log.info("[L2PS-IM] Messaging server stopped")
    }

    // ─── Message Router ──────────────────────────────────────────

    private async handleMessage(ws: ServerWebSocket<WSData>, raw: string): Promise<void> {
        if (raw.length > MAX_MESSAGE_SIZE) {
            this.sendError(ws, "INVALID_MESSAGE", `Message too large (max ${MAX_MESSAGE_SIZE} bytes)`)
            return
        }

        let frame: ProtocolFrame
        try {
            frame = JSON.parse(raw)
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.warn("[L2PSMessagingServer] Invalid JSON message:", errorMsg)
            this.sendError(ws, "INVALID_MESSAGE", "Invalid JSON")
            return
        }

        if (!frame.type || typeof frame.type !== "string" || !frame.payload || typeof frame.payload !== "object") {
            this.sendError(ws, "INVALID_MESSAGE", "Missing or invalid type/payload")
            return
        }

        try {
            switch (frame.type) {
                case "register":
                    await this.handleRegister(ws, frame as RegisterMessage)
                    break
                case "send":
                    await this.handleSend(ws, frame as SendMessage)
                    break
                case "history":
                    await this.handleHistory(ws, frame as HistoryMessage)
                    break
                case "discover":
                    this.handleDiscover(ws)
                    break
                case "request_public_key":
                    this.handleRequestPublicKey(ws, frame.payload.targetId as string)
                    break
                default:
                    this.sendError(ws, "INVALID_MESSAGE", `Unknown type: ${frame.type}`)
            }
        } catch (error) {
            log.error(`[L2PS-IM] Handler error: ${error}`)
            this.sendError(ws, "INTERNAL_ERROR", "Internal server error")
        }
    }

    // ─── Register ────────────────────────────────────────────────

    private async handleRegister(ws: ServerWebSocket<WSData>, msg: RegisterMessage): Promise<void> {
        const { publicKey, l2psUid, proof } = msg.payload

        if (!publicKey || !l2psUid || !proof) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing publicKey, l2psUid, or proof")
            return
        }

        if (publicKey.length < MIN_PUBLIC_KEY_LENGTH || !/^[0-9a-fA-F]+$/.test(publicKey)) {
            this.sendError(ws, "INVALID_MESSAGE", "Invalid publicKey format (expected hex)")
            return
        }

        // Verify L2PS network exists
        const l2ps = await ParallelNetworks.getInstance().getL2PS(l2psUid)
        if (!l2ps) {
            this.sendError(ws, "L2PS_NOT_FOUND", `L2PS network ${l2psUid} not found`)
            return
        }

        // Verify proof of key ownership: sign("register:{publicKey}:{timestamp}")
        const proofMessage = `register:${publicKey}:${msg.timestamp}`
        try {
            const valid = await TxValidatorPool.getInstance().verify({
                algorithm: getSharedState.signingAlgorithm,
                message: new TextEncoder().encode(proofMessage),
                publicKey: this.hexToUint8Array(publicKey),
                signature: this.hexToUint8Array(proof),
            })
            if (!valid) {
                this.sendError(ws, "INVALID_PROOF", "Signature verification failed")
                return
            }
        } catch (error) {
            this.sendError(ws, "INVALID_PROOF", `Proof verification error: ${error}`)
            return
        }

        // Remove old connection if re-registering
        const existing = this.peers.get(publicKey)
        if (existing) {
            try { (existing.ws as ServerWebSocket<WSData>).close() } catch (error) {
                log.debug("[L2PSMessagingServer] Failed to close existing WebSocket:", error instanceof Error ? error.message : String(error))
            }
        }

        // Register peer
        ws.data.publicKey = publicKey
        ws.data.l2psUid = l2psUid
        this.peers.set(publicKey, {
            publicKey,
            l2psUid,
            ws,
            connectedAt: Date.now(),
        })

        // Get online peers in the same L2PS network
        const onlinePeers = Array.from(this.peers.values())
            .filter(p => p.l2psUid === l2psUid && p.publicKey !== publicKey)
            .map(p => p.publicKey)

        // Send registration confirmation
        this.send(ws, {
            type: "registered",
            payload: { success: true, publicKey, l2psUid, onlinePeers },
            timestamp: Date.now(),
        })

        // Notify others of new peer
        for (const peerKey of onlinePeers) {
            const peer = this.peers.get(peerKey)
            if (peer) {
                this.send(peer.ws as ServerWebSocket<WSData>, {
                    type: "peer_joined",
                    payload: { publicKey },
                    timestamp: Date.now(),
                })
            }
        }

        // Deliver queued messages
        await this.deliverQueuedMessages(ws, publicKey, l2psUid)

        log.info(`[L2PS-IM] Peer registered: ${publicKey.slice(0, 12)}... on ${l2psUid}`)
    }

    // ─── Send Message ────────────────────────────────────────────

    private async handleSend(ws: ServerWebSocket<WSData>, msg: SendMessage): Promise<void> {
        const senderKey = ws.data.publicKey
        if (!senderKey) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register before sending")
            return
        }

        const { to, encrypted, messageHash } = msg.payload
        if (!to || !encrypted || !messageHash) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing to, encrypted, or messageHash")
            return
        }

        if (!encrypted.ciphertext || !encrypted.nonce) {
            this.sendError(ws, "INVALID_MESSAGE", "Encrypted payload must have ciphertext and nonce")
            return
        }

        if (encrypted.ciphertext.length > MAX_CIPHERTEXT_SIZE) {
            this.sendError(ws, "INVALID_MESSAGE", `Ciphertext too large (max ${MAX_CIPHERTEXT_SIZE} bytes)`)
            return
        }

        if (to === senderKey) {
            this.sendError(ws, "INVALID_MESSAGE", "Cannot send message to yourself")
            return
        }

        const l2psUid = ws.data.l2psUid!
        const messageId = crypto.randomUUID()
        const recipientPeer = this.peers.get(to)
        const recipientOnline = !!recipientPeer && recipientPeer.l2psUid === l2psUid

        // Process through service (DB + L2PS mempool) before delivering
        const result = await this.service.processMessage(
            senderKey, to, l2psUid, messageId, messageHash, encrypted, recipientOnline,
        )

        if (!result.success) {
            this.sendError(ws, "L2PS_SUBMIT_FAILED", result.error)
            return
        }

        // Route to recipient only after successful persistence
        if (recipientOnline) {
            this.send(recipientPeer!.ws as ServerWebSocket<WSData>, {
                type: "message",
                payload: { from: senderKey, encrypted, messageHash, offline: false },
                timestamp: Date.now(),
            })
            this.send(ws, {
                type: "message_sent",
                payload: {
                    messageHash,
                    l2psStatus: result.l2psTxHash ? "submitted" : "failed",
                },
                timestamp: Date.now(),
            })
        } else {
            this.send(ws, {
                type: "message_queued",
                payload: { messageHash, status: "queued" },
                timestamp: Date.now(),
            })
        }
    }

    // ─── History ─────────────────────────────────────────────────

    private async handleHistory(ws: ServerWebSocket<WSData>, msg: HistoryMessage): Promise<void> {
        const myKey = ws.data.publicKey
        if (!myKey) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register first")
            return
        }

        const { peerKey, before, limit, proof } = msg.payload
        if (!peerKey || !proof) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing peerKey or proof")
            return
        }

        // Verify proof: sign("history:{peerKey}:{timestamp}")
        const proofMessage = `history:${peerKey}:${msg.timestamp}`
        try {
            const valid = await TxValidatorPool.getInstance().verify({
                algorithm: getSharedState.signingAlgorithm,
                message: new TextEncoder().encode(proofMessage),
                publicKey: this.hexToUint8Array(myKey),
                signature: this.hexToUint8Array(proof),
            })
            if (!valid) {
                this.sendError(ws, "INVALID_PROOF", "History proof failed")
                return
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.warn("[L2PSMessagingServer] History proof verification failed:", errorMsg)
            this.sendError(ws, "INVALID_PROOF", "Proof verification error")
            return
        }

        const l2psUid = ws.data.l2psUid!
        const result = await this.service.getHistory(myKey, peerKey, l2psUid, before, limit ?? 50)

        this.send(ws, {
            type: "history_response",
            payload: { messages: result.messages, hasMore: result.hasMore },
            timestamp: Date.now(),
        })
    }

    // ─── Discover ────────────────────────────────────────────────

    private handleDiscover(ws: ServerWebSocket<WSData>): void {
        if (!ws.data.publicKey || !ws.data.l2psUid) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register before discovering peers")
            return
        }

        const l2psUid = ws.data.l2psUid
        const peers = Array.from(this.peers.values())
            .filter(p => p.l2psUid === l2psUid)
            .map(p => p.publicKey)

        this.send(ws, {
            type: "discover_response",
            payload: { peers },
            timestamp: Date.now(),
        })
    }

    // ─── Public Key Request ──────────────────────────────────────

    private handleRequestPublicKey(ws: ServerWebSocket<WSData>, targetId: string): void {
        if (!ws.data.publicKey) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register before requesting public keys")
            return
        }

        if (!targetId) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing targetId")
            return
        }

        // Only return peers in the same L2PS network
        const peer = this.peers.get(targetId)
        const sameNetwork = peer && peer.l2psUid === ws.data.l2psUid
        this.send(ws, {
            type: "public_key_response",
            payload: {
                targetId,
                publicKey: sameNetwork ? peer.publicKey : null,
            },
            timestamp: Date.now(),
        })
    }

    // ─── Connection Close ────────────────────────────────────────

    private handleClose(ws: ServerWebSocket<WSData>): void {
        const publicKey = ws.data.publicKey
        if (!publicKey) return

        const peer = this.peers.get(publicKey)
        if (!peer) return

        // Only remove if this is the current socket (not a stale one after re-register)
        if (peer.ws !== ws) return

        const l2psUid = peer.l2psUid
        this.peers.delete(publicKey)

        // Notify peers in same L2PS network
        for (const [, p] of this.peers) {
            if (p.l2psUid === l2psUid) {
                this.send(p.ws as ServerWebSocket<WSData>, {
                    type: "peer_left",
                    payload: { publicKey },
                    timestamp: Date.now(),
                })
            }
        }

        log.debug(`[L2PS-IM] Peer disconnected: ${publicKey.slice(0, 12)}...`)
    }

    // ─── Offline Delivery ────────────────────────────────────────

    private async deliverQueuedMessages(
        ws: ServerWebSocket<WSData>,
        toKey: string,
        l2psUid: string,
    ): Promise<void> {
        const queued = await this.service.getQueuedMessages(toKey, l2psUid)
        if (queued.length === 0) return

        const deliveredIds: string[] = []
        const senderKeys = new Set<string>()

        for (const msg of queued) {
            try {
                this.send(ws, {
                    type: "message",
                    payload: {
                        from: msg.from,
                        encrypted: msg.encrypted,
                        messageHash: msg.messageHash,
                        offline: true,
                    },
                    timestamp: Date.now(),
                })
                deliveredIds.push(msg.id)
                senderKeys.add(msg.from)
            } catch {
                break // Maintain order — stop on first failure
            }
        }

        if (deliveredIds.length > 0) {
            await this.service.markDelivered(deliveredIds)
            // Reset offline quota only after DB commit succeeds
            for (const key of senderKeys) {
                this.service.resetOfflineCount(key)
            }
            log.info(`[L2PS-IM] Delivered ${deliveredIds.length} queued messages to ${toKey.slice(0, 12)}...`)
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────

    private send(ws: ServerWebSocket<WSData>, frame: ProtocolFrame): void {
        try {
            ws.send(JSON.stringify(frame))
        } catch (error) {
            log.debug(`[L2PS-IM] Send error: ${error}`)
        }
    }

    private sendError(ws: ServerWebSocket<WSData>, code: ErrorCode, message: string): void {
        this.send(ws, {
            type: "error",
            payload: { code, message },
            timestamp: Date.now(),
        })
    }

    private hexToUint8Array(hex: string): Uint8Array {
        const bytes = new Uint8Array(hex.length / 2)
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
        }
        return bytes
    }
}
