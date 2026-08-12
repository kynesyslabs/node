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
import { canonicalizeKey } from "./keys"
import type {
    ConnectedPeer,
    ProtocolFrame,
    RegisterMessage,
    SendMessage,
    HistoryMessage,
    ErrorCode,
} from "./types"

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

// Re-exported from ./keys so external callers (and tests) keep importing it
// from the server module; the service imports it from ./keys directly.
export { canonicalizeKey }

export class L2PSMessagingServer {
    private peers = new Map<string, ConnectedPeer>()
    // Bun.Server / Bun.serve dropped the WSData generic; the cast on
    // `ws.data` accesses at call sites still narrows correctly because
    // we set ws.data in `upgrade()`.
    private server: Server
    private service: L2PSMessagingService

    constructor(port: number) {
        this.service = L2PSMessagingService.getInstance()

        this.server = Bun.serve({
            port,
            fetch: (req, server) => {
                if (server.upgrade(req, { data: { publicKey: null, l2psUid: null } })) {
                    return undefined
                }
                return new Response("WebSocket upgrade required", { status: 426 })
            },
            websocket: {
                // Bun.serve no longer carries a WSData generic on the
                // outer Server type; ws.data is `unknown` at the dispatch
                // boundary even though we set it in upgrade(). The cast
                // is sound because every connection passes through the
                // upgrade() above which provides a fully-shaped WSData.
                message: (ws, message) => this.handleMessage(ws as ServerWebSocket<WSData>, message as string),
                open: () => log.debug("[L2PS-IM] New connection"),
                close: (ws) => this.handleClose(ws as ServerWebSocket<WSData>),
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
        } catch {
            this.sendError(ws, "INVALID_MESSAGE", "Invalid JSON")
            return
        }

        if (!frame.type || typeof frame.type !== "string" || !frame.payload || typeof frame.payload !== "object") {
            this.sendError(ws, "INVALID_MESSAGE", "Missing or invalid type/payload", frame.requestId)
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
                    this.handleDiscover(ws, frame.requestId)
                    break
                case "request_public_key":
                    this.handleRequestPublicKey(ws, frame.payload.targetId as string, frame.requestId)
                    break
                default:
                    this.sendError(ws, "INVALID_MESSAGE", `Unknown type: ${frame.type}`, frame.requestId)
            }
        } catch (error) {
            log.error(`[L2PS-IM] Handler error: ${error}`)
            this.sendError(ws, "INTERNAL_ERROR", "Internal server error", frame.requestId)
        }
    }

    // ─── Register ────────────────────────────────────────────────

    private async handleRegister(ws: ServerWebSocket<WSData>, msg: RegisterMessage): Promise<void> {
        const { publicKey, l2psUid, proof } = msg.payload

        if (!publicKey || !l2psUid || !proof) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing publicKey, l2psUid, or proof", msg.requestId)
            return
        }

        // Canonicalise the key (strip 0x/0X, lowercase) so `0xABCD`, `0Xabcd` and
        // `abcd` all resolve to one peer identity — otherwise the same key
        // registers as two peers. The raw `publicKey` is kept only for the proof
        // message below, which the client signed over its own representation.
        const canonicalKey = canonicalizeKey(publicKey)
        if (canonicalKey.length < MIN_PUBLIC_KEY_LENGTH || !/^[0-9a-f]+$/.test(canonicalKey)) {
            this.sendError(ws, "INVALID_MESSAGE", "Invalid publicKey format (expected hex)", msg.requestId)
            return
        }

        // Verify L2PS network exists
        const l2ps = await ParallelNetworks.getInstance().getL2PS(l2psUid)
        if (!l2ps) {
            this.sendError(ws, "L2PS_NOT_FOUND", `L2PS network ${l2psUid} not found`, msg.requestId)
            return
        }

        // Verify proof of key ownership: sign("register:{publicKey}:{timestamp}")
        const proofMessage = `register:${publicKey}:${msg.timestamp}`
        try {
            const valid = await ucrypto.verify({
                algorithm: getSharedState.signingAlgorithm,
                message: new TextEncoder().encode(proofMessage),
                publicKey: this.hexToUint8Array(publicKey),
                signature: this.hexToUint8Array(proof),
            })
            if (!valid) {
                this.sendError(ws, "INVALID_PROOF", "Signature verification failed", msg.requestId)
                return
            }
        } catch (error) {
            this.sendError(ws, "INVALID_PROOF", `Proof verification error: ${error}`, msg.requestId)
            return
        }

        // Remove old connection if re-registering (canonical identity)
        const existing = this.peers.get(canonicalKey)
        if (existing) {
            try { (existing.ws as ServerWebSocket<WSData>).close() } catch {}
        }

        // Register peer under the canonical identity
        ws.data.publicKey = canonicalKey
        ws.data.l2psUid = l2psUid
        this.peers.set(canonicalKey, {
            publicKey: canonicalKey,
            l2psUid,
            ws,
            connectedAt: Date.now(),
        })

        // Get online peers in the same L2PS network
        const onlinePeers = Array.from(this.peers.values())
            .filter(p => p.l2psUid === l2psUid && p.publicKey !== canonicalKey)
            .map(p => p.publicKey)

        // Send registration confirmation
        this.send(ws, {
            type: "registered",
            payload: { success: true, publicKey: canonicalKey, l2psUid, onlinePeers },
            timestamp: Date.now(),
            requestId: msg.requestId,
        })

        // Notify others of new peer
        for (const peerKey of onlinePeers) {
            const peer = this.peers.get(peerKey)
            if (peer) {
                this.send(peer.ws as ServerWebSocket<WSData>, {
                    type: "peer_joined",
                    payload: { publicKey: canonicalKey },
                    timestamp: Date.now(),
                })
            }
        }

        // Deliver queued messages. Pass the raw registration key too so rows
        // queued by an earlier build under a non-canonical recipient key are
        // still recovered on reconnect.
        await this.deliverQueuedMessages(ws, canonicalKey, l2psUid, publicKey)

        log.info(`[L2PS-IM] Peer registered: ${canonicalKey.slice(0, 12)}... on ${l2psUid}`)
    }

    // ─── Send Message ────────────────────────────────────────────

    private async handleSend(ws: ServerWebSocket<WSData>, msg: SendMessage): Promise<void> {
        const senderKey = ws.data.publicKey
        if (!senderKey) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register before sending", msg.requestId)
            return
        }

        const { to, encrypted, messageHash } = msg.payload
        if (!to || !encrypted || !messageHash) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing to, encrypted, or messageHash", msg.requestId)
            return
        }
        const toKey = canonicalizeKey(to) // canonical recipient identity for routing

        if (!encrypted.ciphertext || !encrypted.nonce) {
            this.sendError(ws, "INVALID_MESSAGE", "Encrypted payload must have ciphertext and nonce", msg.requestId)
            return
        }

        if (encrypted.ciphertext.length > MAX_CIPHERTEXT_SIZE) {
            this.sendError(ws, "INVALID_MESSAGE", `Ciphertext too large (max ${MAX_CIPHERTEXT_SIZE} bytes)`, msg.requestId)
            return
        }

        if (toKey === senderKey) {
            this.sendError(ws, "INVALID_MESSAGE", "Cannot send message to yourself", msg.requestId)
            return
        }

        const l2psUid = ws.data.l2psUid!
        const messageId = crypto.randomUUID()
        const recipientPeer = this.peers.get(toKey)
        const recipientOnline = !!recipientPeer && recipientPeer.l2psUid === l2psUid

        // Process through service (DB + L2PS mempool) before delivering
        const result = await this.service.processMessage(
            senderKey, toKey, l2psUid, messageId, messageHash, encrypted, recipientOnline,
        )

        if (!result.success) {
            this.sendError(ws, "L2PS_SUBMIT_FAILED", result.error, msg.requestId)
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
                requestId: msg.requestId,
            })
        } else {
            this.send(ws, {
                type: "message_queued",
                payload: { messageHash, status: "queued" },
                timestamp: Date.now(),
                requestId: msg.requestId,
            })
        }
    }

    // ─── History ─────────────────────────────────────────────────

    private async handleHistory(ws: ServerWebSocket<WSData>, msg: HistoryMessage): Promise<void> {
        const myKey = ws.data.publicKey
        if (!myKey) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register first", msg.requestId)
            return
        }

        const { peerKey, before, limit, proof } = msg.payload
        if (!peerKey || !proof) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing peerKey or proof", msg.requestId)
            return
        }

        // Verify proof: sign("history:{peerKey}:{timestamp}")
        const proofMessage = `history:${peerKey}:${msg.timestamp}`
        try {
            const valid = await ucrypto.verify({
                algorithm: getSharedState.signingAlgorithm,
                message: new TextEncoder().encode(proofMessage),
                publicKey: this.hexToUint8Array(myKey),
                signature: this.hexToUint8Array(proof),
            })
            if (!valid) {
                this.sendError(ws, "INVALID_PROOF", "History proof failed", msg.requestId)
                return
            }
        } catch (error) {
            // Log the underlying error before we collapse it into the
            // generic INVALID_PROOF response. Auth failures here are
            // operationally interesting — attack attempts, key/scheme
            // misconfigurations — and the silent catch left operators
            // blind to all of them.
            log.warn(`[L2PS-IM] History proof verification error: ${error}`)
            this.sendError(ws, "INVALID_PROOF", "Proof verification error", msg.requestId)
            return
        }

        // Query by the canonical peer identity. Messages are persisted under
        // canonical keys, so the raw peerKey (kept above for the client's proof)
        // would match nothing. myKey is already canonical (set at register).
        const canonicalPeer = canonicalizeKey(peerKey)
        const l2psUid = ws.data.l2psUid!
        const result = await this.service.getHistory(myKey, canonicalPeer, l2psUid, before, limit ?? 50)

        this.send(ws, {
            type: "history_response",
            payload: { messages: result.messages, hasMore: result.hasMore },
            timestamp: Date.now(),
            requestId: msg.requestId,
        })
    }

    // ─── Discover ────────────────────────────────────────────────

    private handleDiscover(ws: ServerWebSocket<WSData>, requestId?: string): void {
        if (!ws.data.publicKey || !ws.data.l2psUid) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register before discovering peers", requestId)
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
            requestId,
        })
    }

    // ─── Public Key Request ──────────────────────────────────────

    private handleRequestPublicKey(ws: ServerWebSocket<WSData>, targetId: string, requestId?: string): void {
        if (!ws.data.publicKey) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register before requesting public keys", requestId)
            return
        }

        if (!targetId) {
            this.sendError(ws, "INVALID_MESSAGE", "Missing targetId", requestId)
            return
        }

        // Only return peers in the same L2PS network (canonical lookup)
        const peer = this.peers.get(canonicalizeKey(targetId))
        const sameNetwork = peer && peer.l2psUid === ws.data.l2psUid
        this.send(ws, {
            type: "public_key_response",
            payload: {
                targetId,
                publicKey: sameNetwork ? peer.publicKey : null,
            },
            timestamp: Date.now(),
            requestId,
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
        rawKey?: string,
    ): Promise<void> {
        const queued = await this.service.getQueuedMessages(toKey, l2psUid, rawKey)
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

    private sendError(
        ws: ServerWebSocket<WSData>,
        code: ErrorCode,
        message: string,
        requestId?: string,
    ): void {
        this.send(ws, {
            type: "error",
            payload: { code, message },
            timestamp: Date.now(),
            requestId,
        })
    }

    private hexToUint8Array(hex: string): Uint8Array {
        // Tolerate a leading 0x — the SDK emits 0x-prefixed hex for both
        // addresses and signatures; without stripping it the bytes are
        // shifted and every proof verification fails.
        const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex
        const bytes = new Uint8Array(clean.length / 2)
        for (let i = 0; i < clean.length; i += 2) {
            bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16)
        }
        return bytes
    }
}
