import type { ServerWebSocket } from "bun"

export type ErrorCode =
    | "INVALID_MESSAGE"
    | "INVALID_PROOF"
    | "INTERNAL_ERROR"
    | "REGISTRATION_REQUIRED"
    | "L2PS_NOT_FOUND"
    | "L2PS_SUBMIT_FAILED"

export interface ConnectedPeer {
    publicKey: string
    l2psUid: string
    ws: ServerWebSocket<any>
    connectedAt: number
}

export interface EncryptedPayload {
    ciphertext: string
    nonce: string
    [key: string]: unknown
}

export interface ProtocolFrame {
    type: string
    payload: Record<string, unknown>
    timestamp: number
}

export interface RegisterMessage extends ProtocolFrame {
    type: "register"
    payload: {
        publicKey: string
        l2psUid: string
        proof: string
    }
}

export interface SendMessage extends ProtocolFrame {
    type: "send"
    payload: {
        to: string
        encrypted: EncryptedPayload
        messageHash: string
    }
}

export interface HistoryMessage extends ProtocolFrame {
    type: "history"
    payload: {
        peerKey: string
        before?: number
        limit?: number
        proof: string
    }
}
