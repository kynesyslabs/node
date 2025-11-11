import { Buffer } from "buffer"
import type { AuthBlock } from "../auth/types"

export interface OmniMessageHeader {
    version: number
    opcode: number
    sequence: number
    payloadLength: number
}

export interface OmniMessage {
    header: OmniMessageHeader
    payload: Buffer
    checksum: number
}

export interface ParsedOmniMessage<TPayload = unknown> {
    header: OmniMessageHeader
    auth: AuthBlock | null       // Present if Flags bit 0 = 1
    payload: TPayload
}

export interface SendOptions {
    timeout?: number
    awaitResponse?: boolean
    retry?: {
        attempts: number
        backoff: "linear" | "exponential"
        initialDelay: number
    }
}

export interface ReceiveContext {
    peerIdentity: string
    connectionId?: string
    remoteAddress?: string
    receivedAt?: number
    requiresAuth?: boolean
    isAuthenticated?: boolean
}

export interface HandlerContext<TPayload = unknown> {
    message: ParsedOmniMessage<TPayload>
    context: ReceiveContext
    /**
     * Fallback helper that should invoke the legacy HTTP flow and return the
     * resulting payload as a buffer to be wrapped inside an OmniMessage
     * response. Implementations supply this function when executing the handler.
     */
    fallbackToHttp: () => Promise<Buffer>
}

export type OmniHandler<TPayload = unknown> = (
    handlerContext: HandlerContext<TPayload>
) => Promise<Buffer>
