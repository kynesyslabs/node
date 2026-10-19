/**
 * L2PSMessagingServer
 *
 * Bun WebSocket server for real-time L2PS-backed messaging.
 * Messages are delivered instantly via WebSocket and persisted through L2PS rollup.
 */

import type { Server, ServerWebSocket } from "bun"
import { ucrypto } from "@kynesyslabs/demosdk/encryption"
import { Config } from "src/config"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { sanitizeForLog } from "@/utilities/logSafe"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"
import {
    L2PSMessagingService,
    parseHistoryPage,
    QUEUED_DELIVERY_PAGE,
    type ProcessMessageResult,
} from "./L2PSMessagingService"
import { canonicalizeKey } from "./keys"
import { SendRateLimiter } from "./sendRateLimiter"
import type {
    ConnectedPeer,
    ProtocolFrame,
    RegisterMessage,
    SendMessage,
    HistoryMessage,
    ErrorCode,
    SerializedEncryptedMessage,
} from "./types"

/** Max raw WebSocket message size (256 KB) */
const MAX_MESSAGE_SIZE = 256 * 1024
/** Max encrypted ciphertext size (128 KB base64) */
const MAX_CIPHERTEXT_SIZE = 128 * 1024
/**
 * The SDK sets messageHash to the hex ed25519 signature of the envelope
 * (128 chars). The field is part of a unique btree index together with the
 * subnet and both keys, and Postgres refuses index rows above about 2.7 KB
 * with an error that is not a duplicate, so a larger value would turn into
 * an internal error after the write instead of a refusal before it. The limit
 * is in bytes because the index row is measured in bytes: a multi-byte string
 * of the same character count is several times larger. A post-quantum
 * signature there needs the index on a digest of the field.
 */
const MAX_MESSAGE_HASH_LENGTH = 2048
/** Min valid hex public key length (ed25519 = 64 hex chars) */
const MIN_PUBLIC_KEY_LENGTH = 64
/** Room for a post-quantum key encoding without admitting an unbounded field. */
const MAX_PUBLIC_KEY_LENGTH = 256
/**
 * Registration needs no subnet membership, so any key holder can mint one
 * fresh proof per millisecond inside the clock window and each lives until
 * the window closes. The memory is bounded so that flood costs registrations,
 * not memory; nothing is evicted early because an evicted proof would replay.
 * The bound is per subnet: a single global bound let one socket fill it and
 * lock every other subnet's registrations out.
 */
export const MAX_USED_REGISTER_PROOFS_PER_SUBNET = 20_000
/** Register frames one socket may send per window, counted before the proof is looked at. */
const REGISTER_FRAMES_PER_SOCKET = 5
const REGISTER_SOCKET_WINDOW_MS = 10_000
/**
 * Register frames one remote address may send per window. Each costs up to
 * two ed25519 verifications, and a new socket is free, so the per-socket
 * limit alone does not bound the CPU an address can burn. Failed proofs count
 * the same as accepted ones.
 */
const REGISTER_FRAMES_PER_ADDRESS = 30
const REGISTER_ADDRESS_WINDOW_MS = 60_000
/** Addresses tracked at once; the oldest entry goes first, which loosens a limit and never blocks anyone. */
export const MAX_TRACKED_ADDRESSES = 10_000
/** Seconds a socket may stay silent; a registered peer that sends nothing is not worth a slot. */
const IDLE_TIMEOUT_SECONDS = 120
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
    /** Last hop named by x-forwarded-for; only read when the relay is told it sits behind a trusted proxy. */
    forwardedFor: string | null
    registerWindow: { count: number; resetAt: number }
}

/**
 * Fixed-window counters per key, bounded in size. Evicting the oldest key when
 * full forgets a count, which lets that address through a little more, but it
 * never refuses an address that has not earned it.
 */
class FrameLimiter {
    private windows = new Map<string, { count: number; resetAt: number }>()

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly maxKeys: number,
    ) {}

    get size(): number {
        return this.windows.size
    }

    clear(): void {
        this.windows.clear()
    }

    /** 0 when the frame is allowed (and counted), otherwise the ms until the window reopens. */
    take(key: string, now: number): number {
        const current = this.windows.get(key)
        if (!current || current.resetAt <= now) {
            this.windows.delete(key)
            this.makeRoom(now)
            this.windows.set(key, { count: 1, resetAt: now + this.windowMs })
            return 0
        }
        if (current.count >= this.limit) return current.resetAt - now
        current.count++
        return 0
    }

    private makeRoom(now: number): void {
        if (this.windows.size < this.maxKeys) return
        for (const [key, window] of this.windows) {
            if (window.resetAt <= now) this.windows.delete(key)
        }
        // Still full: every window is live, so drop the oldest insertions.
        for (const key of this.windows.keys()) {
            if (this.windows.size < this.maxKeys) break
            this.windows.delete(key)
        }
    }
}

/** True only when the operator has said a reverse proxy in front of the relay sets x-forwarded-for. */
function trustsProxy(): boolean {
    return process.env.L2PS_MESSAGING_TRUST_PROXY?.toLowerCase() === "true"
}

/**
 * The last entry is the one the trusted proxy appended; earlier ones are
 * whatever the client claimed.
 */
function lastForwardedHop(header: string | null): string | null {
    const hop = header?.split(",").pop()?.trim()
    return hop ? hop.slice(0, 64) : null
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

interface Refusal {
    code: ErrorCode
    message: string
    retryAfterMs?: number
}

const refusal = (code: ErrorCode, message: string, retryAfterMs?: number): Refusal => ({
    code,
    message,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
})

interface RegisterFrame {
    publicKey: string
    l2psUid: string
    proof: string
    /** Strip 0x/0X and lowercase, so `0xABCD`, `0Xabcd` and `abcd` are one peer. The raw `publicKey` stays for the proof message, which the client signed over its own representation. */
    canonicalKey: string
}

function checkRegisterFrame(payload: RegisterMessage["payload"]): RegisterFrame | Refusal {
    const { publicKey, l2psUid, proof } = payload
    if (!publicKey || !l2psUid || !proof) {
        return refusal("INVALID_MESSAGE", "Missing publicKey, l2psUid, or proof")
    }
    if (typeof publicKey !== "string" || typeof l2psUid !== "string" || typeof proof !== "string") {
        return refusal("INVALID_MESSAGE", "publicKey, l2psUid and proof must be strings")
    }
    const canonicalKey = canonicalizeKey(publicKey)
    if (!isHexKey(canonicalKey)) {
        return refusal("INVALID_MESSAGE", "Invalid publicKey format (expected hex)")
    }
    return { publicKey, l2psUid, proof, canonicalKey }
}

function isHexKey(canonicalKey: string): boolean {
    return (
        canonicalKey.length >= MIN_PUBLIC_KEY_LENGTH &&
        canonicalKey.length <= MAX_PUBLIC_KEY_LENGTH &&
        /^[0-9a-f]+$/.test(canonicalKey)
    )
}

function proofTimestampRefusal(timestamp: unknown, now: number, what: string): Refusal | null {
    if (
        typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        Math.abs(now - timestamp) > REGISTER_PROOF_MAX_SKEW_MS
    ) {
        return refusal(
            "INVALID_PROOF",
            `${what} timestamp must be within ${REGISTER_PROOF_MAX_SKEW_MS / 1000}s of the node clock`,
        )
    }
    return null
}

interface SendFrame {
    toKey: string
    encrypted: SerializedEncryptedMessage
    messageHash: string
}

/**
 * The frame is JSON from a client that is only authenticated by shape: each
 * field is used as a string later, so anything else is refused here rather
 * than surfacing as a handler error or reaching the database.
 */
function checkSendFrame(payload: SendMessage["payload"], senderKey: string): SendFrame | Refusal {
    const { to, encrypted, messageHash } = payload
    if (!to || !encrypted || !messageHash) {
        return refusal("INVALID_MESSAGE", "Missing to, encrypted, or messageHash")
    }
    if (
        typeof to !== "string" ||
        typeof messageHash !== "string" ||
        Buffer.byteLength(messageHash) > MAX_MESSAGE_HASH_LENGTH ||
        typeof encrypted !== "object" ||
        typeof encrypted.ciphertext !== "string" ||
        typeof encrypted.nonce !== "string"
    ) {
        return refusal("INVALID_MESSAGE", "to, messageHash, ciphertext and nonce must be strings")
    }
    if (!encrypted.ciphertext || !encrypted.nonce) {
        return refusal("INVALID_MESSAGE", "Encrypted payload must have ciphertext and nonce")
    }
    if (encrypted.ciphertext.length > MAX_CIPHERTEXT_SIZE) {
        return refusal("INVALID_MESSAGE", `Ciphertext too large (max ${MAX_CIPHERTEXT_SIZE} bytes)`)
    }
    const toKey = canonicalizeKey(to) // canonical recipient identity for routing
    if (!isHexKey(toKey)) {
        return refusal("INVALID_MESSAGE", "Invalid recipient key format (expected hex)")
    }
    if (toKey === senderKey) {
        return refusal("INVALID_MESSAGE", "Cannot send message to yourself")
    }
    return { toKey, encrypted, messageHash }
}

export class L2PSMessagingServer {
    private peers = new Map<string, ConnectedPeer>()
    /** Register proofs already accepted, by subnet and then proof bytes, until their timestamp leaves the window. */
    private usedRegisterProofs = new Map<string, Map<string, number>>()
    private lastProofPrune = 0
    /** Per sender key, so a throwaway key cannot flood a subnet's queue. */
    private sendLimiter: SendRateLimiter
    private registerByAddress = new FrameLimiter(
        REGISTER_FRAMES_PER_ADDRESS,
        REGISTER_ADDRESS_WINDOW_MS,
        MAX_TRACKED_ADDRESSES,
    )
    // Bun.Server / Bun.serve dropped the WSData generic; the cast on
    // `ws.data` accesses at call sites still narrows correctly because
    // we set ws.data in `upgrade()`.
    private server: Server
    private service: L2PSMessagingService

    constructor(port: number) {
        this.service = L2PSMessagingService.getInstance()
        const { messagingSendRate, messagingSendBurst } = Config.getInstance().l2ps
        this.sendLimiter = new SendRateLimiter({ ratePerSec: messagingSendRate, burst: messagingSendBurst })

        this.server = Bun.serve({
            port,
            fetch: (req, server) => {
                const data: WSData = {
                    publicKey: null,
                    l2psUid: null,
                    forwardedFor: trustsProxy() ? lastForwardedHop(req.headers.get("x-forwarded-for")) : null,
                    registerWindow: { count: 0, resetAt: 0 },
                }
                if (server.upgrade(req, { data })) {
                    return undefined
                }
                return new Response("WebSocket upgrade required", { status: 426 })
            },
            websocket: {
                // Bun reads the whole frame before the handler sees it, so the
                // size check in handleMessage alone would still let a 16 MB
                // frame be received first. Over the limit Bun closes the socket.
                maxPayloadLength: MAX_MESSAGE_SIZE,
                idleTimeout: IDLE_TIMEOUT_SECONDS,
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
        // Bytes, not characters: the limit exists for the memory the frame takes.
        if (Buffer.byteLength(raw) > MAX_MESSAGE_SIZE) {
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

        // JSON.parse accepts "null", numbers and arrays, none of which carry a frame.
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
            this.sendError(ws, "INVALID_MESSAGE", "Frame must be a JSON object")
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
        // Before anything that costs CPU: a signature check is the expensive
        // part and a flood of bad frames must not get to it for free.
        const limited = this.registerRateRefusal(ws, Date.now())
        if (limited) return this.refuse(ws, limited, msg.requestId)

        const frame = checkRegisterFrame(msg.payload)
        if ("code" in frame) return this.refuse(ws, frame, msg.requestId)

        const refusal = await this.checkRegisterProof(msg, frame)
        if (refusal) return this.refuse(ws, refusal, msg.requestId)

        const onlinePeers = this.attachPeer(ws, frame.l2psUid, frame.canonicalKey)
        this.confirmRegistration(ws, msg.requestId, frame, onlinePeers)

        // Deliver queued messages. Rows are stored canonically (persist boundary
        // + migration), so the canonical identity finds every queued message.
        await this.deliverQueuedMessages(ws, frame.canonicalKey, frame.l2psUid)

        log.info(`[L2PS-IM] Peer registered: ${frame.canonicalKey.slice(0, 12)}... on ${frame.l2psUid}`)
    }

    private refuse(ws: ServerWebSocket<WSData>, refusal: Refusal, requestId?: string): void {
        this.sendError(ws, refusal.code, refusal.message, requestId, refusal.retryAfterMs)
    }

    /** Counts a register frame against its socket and its remote address; a refusal says when to retry. */
    private registerRateRefusal(ws: ServerWebSocket<WSData>, now: number): Refusal | null {
        const window = ws.data.registerWindow
        if (window.resetAt <= now) {
            window.count = 0
            window.resetAt = now + REGISTER_SOCKET_WINDOW_MS
        }
        if (window.count >= REGISTER_FRAMES_PER_SOCKET) {
            return refusal("RATE_LIMITED", "Too many register attempts on this connection", window.resetAt - now)
        }
        window.count++

        const retryAfterMs = this.registerByAddress.take(ws.data.forwardedFor ?? ws.remoteAddress ?? "unknown", now)
        if (retryAfterMs > 0) {
            return refusal("RATE_LIMITED", "Too many register attempts from this address", retryAfterMs)
        }
        return null
    }

    /** Everything about a register frame that is checked before its proof: the subnet, the clock, the signature, the replay cache. */
    private async checkRegisterProof(msg: RegisterMessage, frame: RegisterFrame): Promise<Refusal | null> {
        const l2ps = await ParallelNetworks.getInstance().getL2PS(frame.l2psUid)
        if (!l2ps) return refusal("L2PS_NOT_FOUND", `L2PS network ${frame.l2psUid} not found`)

        const now = Date.now()
        const skewed = proofTimestampRefusal(msg.timestamp, now, "Register")
        if (skewed) return skewed

        // Tracked per subnet: a legacy proof does not name one, a client may
        // register one key on two subnets with the same timestamp, and one
        // subnet filling its memory must not refuse the others.
        this.pruneRegisterProofs(now)
        const used = this.proofsOf(frame.l2psUid)
        // Checked before the signature, so a full memory also stops the CPU cost.
        if (used.size >= MAX_USED_REGISTER_PROOFS_PER_SUBNET) {
            return refusal("RATE_LIMITED", "Too many recent registrations, retry later", REGISTER_PROOF_MAX_SKEW_MS)
        }

        const proofBytes = await this.verifyRegisterSignature(frame, msg.timestamp)
        if (!(proofBytes instanceof Uint8Array)) return proofBytes

        // ed25519 signatures are deterministic, so a replayed proof is
        // byte-identical to the one already accepted. Keyed on the bytes that
        // verified, so no re-encoding of an accepted proof counts as a new one.
        const proofKey = Buffer.from(proofBytes).toString("hex")
        if (used.has(proofKey)) {
            return refusal("INVALID_PROOF", "Register proof already used")
        }
        // Concurrent registrations passed the check above together.
        if (used.size >= MAX_USED_REGISTER_PROOFS_PER_SUBNET) {
            return refusal("RATE_LIMITED", "Too many recent registrations, retry later", REGISTER_PROOF_MAX_SKEW_MS)
        }
        used.set(proofKey, msg.timestamp + REGISTER_PROOF_MAX_SKEW_MS)
        return null
    }

    private proofsOf(l2psUid: string): Map<string, number> {
        let used = this.usedRegisterProofs.get(l2psUid)
        if (!used) {
            used = new Map()
            this.usedRegisterProofs.set(l2psUid, used)
        }
        return used
    }

    /**
     * Verify proof of key ownership. The bound form names the subnet:
     * sign("register:{l2psUid}:{publicKey}:{timestamp}"); the legacy
     * sign("register:{publicKey}:{timestamp}") is still accepted. Returns the
     * proof bytes that verified, or the reason they did not.
     */
    private async verifyRegisterSignature(frame: RegisterFrame, timestamp: number): Promise<Uint8Array | Refusal> {
        const { publicKey, l2psUid, proof } = frame
        const proofMessages = [
            `register:${l2psUid}:${publicKey}:${timestamp}`,
            `register:${publicKey}:${timestamp}`,
        ]
        try {
            const proofBytes = this.hexToUint8Array(proof)
            const keyBytes = this.hexToUint8Array(publicKey)
            for (const proofMessage of proofMessages) {
                const valid = await ucrypto.verify({
                    algorithm: getSharedState.signingAlgorithm,
                    message: new TextEncoder().encode(proofMessage),
                    publicKey: keyBytes,
                    signature: proofBytes,
                })
                if (valid) return proofBytes
            }
            return refusal("INVALID_PROOF", "Signature verification failed")
        } catch (error) {
            // The library's text is for the log; the client only learns the proof was unusable.
            log.debug(`[L2PS-IM] Register proof verification error: ${sanitizeForLog(error, 200)}`)
            return refusal("INVALID_PROOF", "Proof verification error")
        }
    }

    /** Puts the socket under its canonical identity and returns the other peers already on the subnet. */
    private attachPeer(ws: ServerWebSocket<WSData>, l2psUid: string, canonicalKey: string): string[] {
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

        ws.data.publicKey = canonicalKey
        ws.data.l2psUid = l2psUid
        this.peers.set(id, {
            publicKey: canonicalKey,
            l2psUid,
            ws,
            connectedAt: Date.now(),
        })

        return Array.from(this.peers.values())
            .filter(p => p.l2psUid === l2psUid && p.publicKey !== canonicalKey)
            .map(p => p.publicKey)
    }

    private confirmRegistration(
        ws: ServerWebSocket<WSData>,
        requestId: string | undefined,
        frame: RegisterFrame,
        onlinePeers: string[],
    ): void {
        const { l2psUid, canonicalKey } = frame
        this.send(ws, {
            type: "registered",
            payload: { success: true, publicKey: canonicalKey, l2psUid, onlinePeers },
            timestamp: Date.now(),
            requestId,
        })

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
    }

    // ─── Send Message ────────────────────────────────────────────

    private async handleSend(ws: ServerWebSocket<WSData>, msg: SendMessage): Promise<void> {
        const senderKey = ws.data.publicKey
        if (!senderKey) {
            this.sendError(ws, "REGISTRATION_REQUIRED", "Register before sending", msg.requestId)
            return
        }

        const frame = checkSendFrame(msg.payload, senderKey)
        if ("code" in frame) return this.refuse(ws, frame, msg.requestId)
        const { toKey, encrypted, messageHash } = frame

        // Before any database work: a sender over its rate costs the node
        // nothing beyond this check, and the socket stays usable.
        const allowance = this.sendLimiter.take(senderKey)
        if (!allowance.allowed) {
            this.sendError(ws, "RATE_LIMITED", "Sending too fast, retry later", msg.requestId, allowance.retryAfterMs)
            return
        }

        const l2psUid = ws.data.l2psUid!
        const recipientPeer = this.peers.get(peerId(l2psUid, toKey))

        // Process through service (DB + L2PS mempool) before delivering
        const result = await this.service.processMessage(
            senderKey, toKey, l2psUid, crypto.randomUUID(), messageHash, encrypted, !!recipientPeer,
        )

        if (!result.success) {
            this.sendError(ws, result.code ?? "L2PS_SUBMIT_FAILED", result.error, msg.requestId, result.retryAfterMs)
            return
        }

        // A resend of an accepted message gets the original answer and is not
        // routed again: the recipient already has it or will get it from the queue.
        if (result.duplicate) {
            this.replyToResend(ws, msg.requestId, messageHash, result.status)
            return
        }

        await this.routeAndReply(ws, msg.requestId, {
            senderKey,
            recipientPeer,
            encrypted: result.encrypted ?? encrypted,
            messageHash,
            result,
        })
    }

    private replyToResend(
        ws: ServerWebSocket<WSData>,
        requestId: string | undefined,
        messageHash: string,
        status: string | undefined,
    ): void {
        this.send(ws, status === "queued" || status === "sent"
            ? {
                type: "message_queued",
                payload: { messageHash, status: "queued", duplicate: true },
                timestamp: Date.now(),
                requestId,
            }
            : {
                type: "message_sent",
                // A failed original is retried, never answered as a duplicate.
                payload: { messageHash, l2psStatus: "submitted", duplicate: true },
                timestamp: Date.now(),
                requestId,
            })
    }

    /**
     * Route to the recipient only after successful persistence. A socket the
     * node still lists can already be gone; then the message waits in the
     * queue instead of being recorded as delivered.
     */
    private async routeAndReply(
        ws: ServerWebSocket<WSData>,
        requestId: string | undefined,
        delivery: {
            senderKey: string
            recipientPeer: ConnectedPeer | undefined
            encrypted: SerializedEncryptedMessage
            messageHash: string
            result: ProcessMessageResult
        },
    ): Promise<void> {
        const { senderKey, recipientPeer, encrypted, messageHash, result } = delivery
        const routed = recipientPeer !== undefined && this.send(recipientPeer.ws as ServerWebSocket<WSData>, {
            type: "message",
            payload: { from: senderKey, encrypted, messageHash, offline: false },
            timestamp: Date.now(),
        })
        if (recipientPeer && !routed) {
            const kept = await this.service.requeue(result.messageId!, senderKey)
            if (!kept) {
                this.sendError(ws, "QUEUE_FULL", "Recipient has too many queued messages", requestId)
                return
            }
        }

        this.send(ws, routed
            ? {
                type: "message_sent",
                payload: { messageHash, l2psStatus: result.l2psTxHash ? "submitted" : "failed" },
                timestamp: Date.now(),
                requestId,
            }
            : {
                type: "message_queued",
                payload: { messageHash, status: "queued" },
                timestamp: Date.now(),
                requestId,
            })
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

        // A proof with no freshness would let one captured frame read the
        // conversation for as long as the key lives.
        const stale = proofTimestampRefusal(msg.timestamp, Date.now(), "History")
        if (stale) {
            this.refuse(ws, stale, msg.requestId)
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

        const page = parseHistoryPage(before, limit)
        if ("error" in page) {
            this.sendError(ws, "INVALID_MESSAGE", page.error, msg.requestId)
            return
        }

        // getHistory canonicalises both keys for the lookup; peerKey stays raw
        // here because the proof above was signed over the client's own form.
        const l2psUid = ws.data.l2psUid!
        const result = await this.service.getHistory(myKey, peerKey, l2psUid, page.before, page.limit)

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
        let delivered = 0
        let previousFirstId: string | undefined

        // A page at a time: the queue is filled by other keys, so loading it
        // whole puts its size in the hands of whoever wrote to this recipient.
        // Delivered rows leave "queued", so each query starts at the front again.
        for (;;) {
            const page = await this.service.getQueuedMessages(toKey, l2psUid, QUEUED_DELIVERY_PAGE)
            // The same head twice means the rows were not marked; looping would resend them forever.
            if (page.length === 0 || page[0].id === previousFirstId) break
            previousFirstId = page[0].id

            const deliveredIds: string[] = []
            for (const msg of page) {
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
            }

            if (deliveredIds.length > 0) {
                // Frees exactly the delivered rows' slots; the sender's messages
                // still queued for other recipients keep theirs.
                await this.service.markDelivered(deliveredIds)
                delivered += deliveredIds.length
            }
            if (deliveredIds.length < page.length || page.length < QUEUED_DELIVERY_PAGE) break
        }

        if (delivered > 0) {
            log.info(`[L2PS-IM] Delivered ${delivered} queued messages to ${toKey.slice(0, 12)}...`)
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────

    private pruneRegisterProofs(now: number): void {
        if (now - this.lastProofPrune < 1000) return
        this.lastProofPrune = now
        for (const [l2psUid, used] of this.usedRegisterProofs) {
            for (const [proof, expiresAt] of used) {
                if (expiresAt < now) used.delete(proof)
            }
            if (used.size === 0) this.usedRegisterProofs.delete(l2psUid)
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
        retryAfterMs?: number,
    ): void {
        this.send(ws, {
            type: "error",
            payload: { code, message, ...(retryAfterMs !== undefined && { retryAfterMs: Math.ceil(retryAfterMs) }) },
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
