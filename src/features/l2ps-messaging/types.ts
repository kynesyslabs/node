/**
 * L2PS Messaging Protocol Types
 *
 * WebSocket protocol for real-time messaging backed by L2PS rollup.
 * Messages are delivered instantly via WebSocket and persisted through
 * the L2PS batch → proof → L1 pipeline.
 */

// ─── Message Envelope ────────────────────────────────────────────

/** The core message envelope that gets encrypted and sent through L2PS */
export interface MessageEnvelope {
    /** Unique message ID (UUID v4) */
    id: string
    /** Sender's ed25519 public key (hex) */
    from: string
    /** Recipient's ed25519 public key (hex) */
    to: string
    /** Message type discriminator */
    type: MessageType
    /** Message content (plaintext before E2E encryption) */
    content: string
    /** Unix timestamp (ms) when message was created by sender */
    timestamp: number
    /** Optional: reply to another message ID */
    replyTo?: string
    /** Sender's ed25519 signature of the envelope (hex) */
    signature: string
}

export type MessageType =
    | "text"       // Plain text message
    | "media"      // Media reference (URL/hash)
    | "reaction"   // Reaction to a message
    | "system"     // System notification
    | "transfer"   // Token transfer (future — requires L1 finality)

// ─── WebSocket Protocol ──────────────────────────────────────────

/** Client → Server message types */
export type ClientMessageType =
    | "register"
    | "send"
    | "history"
    | "discover"
    | "request_public_key"
    | "ack"

/** Server → Client message types */
export type ServerMessageType =
    | "registered"
    | "message"
    | "message_sent"
    | "message_queued"
    | "history_response"
    | "discover_response"
    | "public_key_response"
    | "peer_joined"
    | "peer_left"
    | "error"

/** Base protocol frame */
export interface ProtocolFrame<T extends string = string> {
    type: T
    payload: Record<string, unknown>
    timestamp: number
}

// ─── Client → Server Messages ────────────────────────────────────

export interface RegisterMessage extends ProtocolFrame<"register"> {
    payload: {
        /** Client's ed25519 public key (hex) */
        publicKey: string
        /** L2PS network UID to join */
        l2psUid: string
        /** Proof: sign("register:{publicKey}:{timestamp}") */
        proof: string
    }
}

export interface SendMessage extends ProtocolFrame<"send"> {
    payload: {
        /** Recipient's public key (hex) */
        to: string
        /** E2E encrypted message envelope (serialized) */
        encrypted: SerializedEncryptedMessage
        /** Original message hash for dedup */
        messageHash: string
    }
}

export interface HistoryMessage extends ProtocolFrame<"history"> {
    payload: {
        /** Peer public key to get conversation with */
        peerKey: string
        /** Pagination: messages before this timestamp */
        before?: number
        /** Max messages to return */
        limit?: number
        /** Proof: sign("history:{peerKey}:{timestamp}") */
        proof: string
    }
}

export interface DiscoverMessage extends ProtocolFrame<"discover"> {
    payload: {}
}

export interface RequestPublicKeyMessage extends ProtocolFrame<"request_public_key"> {
    payload: {
        /** Target peer's public key or alias */
        targetId: string
    }
}

// ─── Server → Client Messages ────────────────────────────────────

export interface RegisteredResponse extends ProtocolFrame<"registered"> {
    payload: {
        success: boolean
        publicKey: string
        l2psUid: string
        onlinePeers: string[]
    }
}

export interface IncomingMessage extends ProtocolFrame<"message"> {
    payload: {
        /** Sender's public key */
        from: string
        /** E2E encrypted envelope */
        encrypted: SerializedEncryptedMessage
        /** Message hash */
        messageHash: string
        /** Whether this was delivered from offline storage */
        offline?: boolean
    }
}

export interface MessageSentResponse extends ProtocolFrame<"message_sent"> {
    payload: {
        messageHash: string
        /** L2PS mempool status */
        l2psStatus: "submitted" | "failed"
    }
}

export interface MessageQueuedResponse extends ProtocolFrame<"message_queued"> {
    payload: {
        messageHash: string
        /** Recipient was offline, message queued */
        status: "queued"
    }
}

export interface HistoryResponse extends ProtocolFrame<"history_response"> {
    payload: {
        messages: StoredMessage[]
        hasMore: boolean
    }
}

export interface DiscoverResponse extends ProtocolFrame<"discover_response"> {
    payload: {
        peers: string[]
    }
}

export interface PublicKeyResponse extends ProtocolFrame<"public_key_response"> {
    payload: {
        targetId: string
        publicKey: string | null
    }
}

export interface PeerJoinedNotification extends ProtocolFrame<"peer_joined"> {
    payload: {
        publicKey: string
    }
}

export interface PeerLeftNotification extends ProtocolFrame<"peer_left"> {
    payload: {
        publicKey: string
    }
}

export interface ErrorResponse extends ProtocolFrame<"error"> {
    payload: {
        code: ErrorCode
        message: string
        details?: string
    }
}

// ─── Encryption Types ────────────────────────────────────────────

/** Serialized E2E encrypted message for wire transport */
export interface SerializedEncryptedMessage {
    /** Encrypted data (base64) */
    ciphertext: string
    /** AES-GCM nonce/IV (base64) */
    nonce: string
    /** Ephemeral public key for DH (hex) — if using X25519 */
    ephemeralKey?: string
}

// ─── Storage Types ───────────────────────────────────────────────

/** Message as stored in the database */
export interface StoredMessage {
    id: string
    from: string
    to: string
    messageHash: string
    encrypted: SerializedEncryptedMessage
    l2psUid: string
    l2psTxHash: string | null
    timestamp: number
    status: MessageStatus
}

export type MessageStatus =
    | "delivered"   // Sent to recipient via WS
    | "queued"      // Recipient offline, stored for later delivery
    | "sent"        // Delivered from offline queue
    | "failed"      // L2PS submission or persistence failed
    | "l2ps_pending" // In L2PS mempool, not yet batched
    | "l2ps_batched" // Included in L2PS batch
    | "l2ps_confirmed" // Confirmed on L1

// ─── Error Codes ─────────────────────────────────────────────────

export type ErrorCode =
    | "INVALID_MESSAGE"
    | "REGISTRATION_REQUIRED"
    | "INVALID_PROOF"
    | "PEER_NOT_FOUND"
    | "L2PS_NOT_FOUND"
    | "L2PS_SUBMIT_FAILED"
    | "RATE_LIMITED"
    | "INTERNAL_ERROR"

// ─── Connected Peer ──────────────────────────────────────────────

export interface ConnectedPeer {
    publicKey: string
    l2psUid: string
    ws: unknown // Bun ServerWebSocket — typed loosely for portability
    connectedAt: number
}
