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
/** A hash is a digest or a signature in hex; this leaves room for either. */
const MAX_MESSAGE_HASH_LENGTH = 1024
/** Min valid hex public key length (ed25519 = 64 hex chars) */
const MIN_PUBLIC_KEY_LENGTH = 64
/**
 * How far a register frame's timestamp may sit from the node clock. The proof
 * signs only the key, that timestamp and (in the bound form) the subnet, so
 * without a window a proof seen once would register its key forever, taking
 * over the owner's queued messages. Same allowance as history reads.
 */
export const REGISTER_PROOF_MAX_SKEW_MS = 5 * 60_000

interface WSData {
    publicKey: string | null
    l2psUid: string | null
}

// Re-exported from ./keys so external callers (and tests) keep importing it
// from the server module; the service imports it from ./keys directly.
export { canonicalizeKey }

/**
 * A key may be registered on several subnets at once, one socket per subnet,
 * so the peer table is keyed by both. Hex keys never contain "|".
 */
function peerId(l2psUid: string, publicKey: string): string {
    return `${publicKey}|${l2psUid}`
}

export class L2PSMessagingServer {
    private peers = new Map<string, ConnectedPeer>()
    /** Register proofs already accepted per subnet, until their timestamp leaves the window. */
    private usedRegisterProofs = new Map<string, number>()
    private lastProofPrune = 0
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
        if (typeof publicKey !== "string" || typeof l2psUid !== "string" || typeof proof !== "string") {
            this.sendError(ws, "INVALID_MESSAGE", "publicKey, l2psUid and proof must be strings", msg.requestId)
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

        const now = Date.now()
        if (
            typeof msg.timestamp !== "number" ||
            !Number.isFinite(msg.timestamp) ||
            Math.abs(now - msg.timestamp) > REGISTER_PROOF_MAX_SKEW_MS
        ) {
            this.sendError(
                ws,
                "INVALID_PROOF",
                `Register timestamp must be within ${REGISTER_PROOF_MAX_SKEW_MS / 1000}s of the node clock`,
                msg.requestId,
            )
            return
        }

        // Verify proof of key ownership. The bound form names the subnet:
        // sign("register:{l2psUid}:{publicKey}:{timestamp}"); the legacy
        // sign("register:{publicKey}:{timestamp}") is still accepted.
        const proofMessages = [
            `register:${l2psUid}:${publicKey}:${msg.timestamp}`,
            `register:${publicKey}:${msg.timestamp}`,
        ]
        let proofBytes: Uint8Array
        let keyBytes: Uint8Array
        try {
            proofBytes = this.hexToUint8Array(proof)
            keyBytes = this.hexToUint8Array(publicKey)
        } catch (error) {
            this.sendError(ws, "INVALID_PROOF", `Proof verification error: ${error}`, msg.requestId)
            return
        }
        try {
            let valid = false
            for (const proofMessage of proofMessages) {
                valid = await ucrypto.verify({
                    algorithm: getSharedState.signingAlgorithm,
                    message: new TextEncoder().encode(proofMessage),
                    publicKey: keyBytes,
                    signature: proofBytes,
                })
                if (valid) break
            }
            if (!valid) {
                this.sendError(ws, "INVALID_PROOF", "Signature verification failed", msg.requestId)
                return
            }
        } catch (error) {
            this.sendError(ws, "INVALID_PROOF", `Proof verification error: ${error}`, msg.requestId)
            return
        }

        // ed25519 signatures are deterministic, so a replayed proof is
        // byte-identical to the one already accepted. Keyed on the bytes that
        // verified, so no re-encoding of an accepted proof counts as a new one.
        // Tracked per subnet: a legacy proof does not name one, and a client
        // may register one key on two subnets with the same timestamp.
        const proofKey = `${l2psUid}|${Buffer.from(proofBytes).toString("hex")}`
        this.pruneRegisterProofs(now)
        if (this.usedRegisterProofs.has(proofKey)) {
            this.sendError(ws, "INVALID_PROOF", "Register proof already used", msg.requestId)
            return
        }
        this.usedRegisterProofs.set(proofKey, msg.timestamp + REGISTER_PROOF_MAX_SKEW_MS)

        // A socket re-registering moves to the new identity; drop the old one.
        if (ws.data.publicKey && ws.data.l2psUid) {
            this.detach(ws)
        }

        // Remove old connection if re-registering on this subnet (canonical identity)
        const id = peerId(l2psUid, canonicalKey)
        const existing = this.peers.get(id)
        if (existing && existing.ws !== ws) {
            // Closing an already-dead socket can throw; we're replacing this
            // connection regardless, so a close failure here is irrelevant.
            try {
                (existing.ws as ServerWebSocket<WSData>).close()
            } catch {
                /* replaced regardless — ignore */
            }
        }

        // Register peer under the canonical identity
        ws.data.publicKey = canonicalKey
        ws.data.l2psUid = l2psUid
        this.peers.set(id, {
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
            const peer = this.peers.get(peerId(l2psUid, peerKey))
            if (peer) {
                this.send(peer.ws as ServerWebSocket<WSData>, {
                    type: "peer_joined",
                    payload: { publicKey: canonicalKey },
                    timestamp: Date.now(),
                })
            }
        }

        // Deliver queued messages. Rows are stored canonically (persist boundary
        // + migration), so the canonical identity finds every queued message.
        await this.deliverQueuedMessages(ws, canonicalKey, l2psUid)

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
        // The frame is JSON from an unauthenticated-in-shape client: each
        // field is used as a string below, so anything else is refused here
        // rather than surfacing as a handler error or reaching the database.
        if (
            typeof to !== "string" ||
            typeof messageHash !== "string" ||
            messageHash.length > MAX_MESSAGE_HASH_LENGTH ||
            typeof encrypted !== "object" ||
            typeof encrypted.ciphertext !== "string" ||
            typeof encrypted.nonce !== "string"
        ) {
            this.sendError(ws, "INVALID_MESSAGE", "to, messageHash, ciphertext and nonce must be strings", msg.requestId)
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
        const recipientPeer = this.peers.get(peerId(l2psUid, toKey))
        const recipientOnline = !!recipientPeer

        // Process through service (DB + L2PS mempool) before delivering
        const result = await this.service.processMessage(
            senderKey, toKey, l2psUid, messageId, messageHash, encrypted, recipientOnline,
        )

        if (!result.success) {
            this.sendError(ws, "L2PS_SUBMIT_FAILED", result.error, msg.requestId)
            return
        }

        // A resend of an accepted message gets the original answer and is not
        // routed again: the recipient already has it or will get it from the queue.
        if (result.duplicate) {
            this.send(ws, result.status === "queued" || result.status === "sent"
                ? {
                    type: "message_queued",
                    payload: { messageHash, status: "queued", duplicate: true },
                    timestamp: Date.now(),
                    requestId: msg.requestId,
                }
                : {
                    type: "message_sent",
                    // A failed original is retried, never answered as a duplicate.
                    payload: { messageHash, l2psStatus: "submitted", duplicate: true },
                    timestamp: Date.now(),
                    requestId: msg.requestId,
                })
            return
        }

        // Route to recipient only after successful persistence. A socket the
        // node still lists can already be gone; then the message waits in the
        // queue instead of being recorded as delivered.
        const routed = recipientOnline && this.send(recipientPeer!.ws as ServerWebSocket<WSData>, {
            type: "message",
            payload: { from: senderKey, encrypted, messageHash, offline: false },
            timestamp: Date.now(),
        })
        if (recipientOnline && !routed) {
            await this.service.requeue(result.messageId!, senderKey)
        }

        if (routed) {
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
        if (typeof peerKey !== "string" || typeof proof !== "string") {
            this.sendError(ws, "INVALID_MESSAGE", "peerKey and proof must be strings", msg.requestId)
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

        // getHistory canonicalises both keys for the lookup; peerKey stays raw
        // here because the proof above was signed over the client's own form.
        const l2psUid = ws.data.l2psUid!
        const result = await this.service.getHistory(myKey, peerKey, l2psUid, before, limit)

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
        const peer = this.peers.get(peerId(ws.data.l2psUid!, canonicalizeKey(targetId)))
        this.send(ws, {
            type: "public_key_response",
            payload: {
                targetId,
                publicKey: peer ? peer.publicKey : null,
            },
            timestamp: Date.now(),
            requestId,
        })
    }

    // ─── Connection Close ────────────────────────────────────────

    private handleClose(ws: ServerWebSocket<WSData>): void {
        this.detach(ws)
    }

    /** Remove the socket's current registration and tell its subnet. */
    private detach(ws: ServerWebSocket<WSData>): void {
        const { publicKey, l2psUid } = ws.data
        if (!publicKey || !l2psUid) return

        const id = peerId(l2psUid, publicKey)
        const peer = this.peers.get(id)
        if (!peer) return

        // Only remove if this is the current socket (not a stale one after re-register)
        if (peer.ws !== ws) return

        this.peers.delete(id)

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
            const sent = this.send(ws, {
                type: "message",
                payload: {
                    from: msg.from,
                    encrypted: msg.encrypted,
                    messageHash: msg.messageHash,
                    offline: true,
                },
                timestamp: Date.now(),
            })
            if (!sent) break // Maintain order — stop on first failure
            deliveredIds.push(msg.id)
            senderKeys.add(msg.from)
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

    private pruneRegisterProofs(now: number): void {
        if (now - this.lastProofPrune < 1000) return
        this.lastProofPrune = now
        for (const [proof, expiresAt] of this.usedRegisterProofs) {
            if (expiresAt < now) this.usedRegisterProofs.delete(proof)
        }
    }

    /** False when the frame was dropped (Bun returns 0 for a closed socket). */
    private send(ws: ServerWebSocket<WSData>, frame: ProtocolFrame): boolean {
        try {
            return ws.send(JSON.stringify(frame)) !== 0
        } catch (error) {
            log.debug(`[L2PS-IM] Send error: ${error}`)
            return false
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
        // shifted and every proof verification fails. Anything that is not
        // whole bytes of hex is refused rather than truncated: a lenient
        // decoder let a proof with a stray trailing character verify as the
        // original while looking new to the replay cache.
        const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex
        if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
            throw new Error("Expected whole bytes of hex")
        }
        return new Uint8Array(Buffer.from(clean, "hex"))
    }
}
