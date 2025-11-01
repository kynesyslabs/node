import { Buffer } from "buffer"

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
    payload: TPayload
    checksum: number
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
    connectionId: string
    receivedAt: number
    requiresAuth: boolean
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
