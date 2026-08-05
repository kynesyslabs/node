import log from "src/utilities/logger"

import { OmniOpcode, opcodeToString } from "@/libs/omniprotocol/protocol/opcodes"
import { SignatureMode, type AuthBlock } from "@/libs/omniprotocol/auth/types"
import type { OmniMessageHeader } from "@/libs/omniprotocol/types/message"
import {
    decodeJsonRequest,
    decodeRpcResponse,
} from "@/libs/omniprotocol/serialization/jsonEnvelope"
import {
    decodeNodeCallRequest,
    decodePeerlistSyncRequest,
} from "@/libs/omniprotocol/serialization/control"
import {
    decodeGreenlightRequest,
    decodeProposeBlockHashRequest,
    decodeSetValidatorPhaseRequest,
} from "@/libs/omniprotocol/serialization/consensus"
import {
    decodeBlockHashRequest,
    decodeBlockSyncRequest,
    decodeBlocksRequest,
    decodeMempoolMergeRequest,
    decodeMempoolSyncRequest,
    decodeTransactionHashRequest,
} from "@/libs/omniprotocol/serialization/sync"
import {
    decodeCapabilityExchangeRequest,
    decodeProtocolDisconnect,
    decodeProtocolError,
    decodeProtocolPing,
    decodeVersionNegotiateRequest,
} from "@/libs/omniprotocol/serialization/meta"
import { decodeL2PSHashUpdate } from "@/libs/omniprotocol/serialization/l2ps"

export const RESPONSE_OPCODE = 0xff

const PAYLOAD_HEAD = 96
const PAYLOAD_TAIL = 48
const HEX_PREVIEW_BYTES = 24

export type TraceSite =
    | "framer"
    | "extract-abort"
    | "unmatched-response"
    | "request"
    | "response-drop"

export interface TraceConnection {
    peerIdentity: string
    socketId: string | null
    origin: string
    remoteAddress?: string
}

type PayloadDecoder = (buffer: Buffer) => unknown

const DECODERS: Partial<Record<number, PayloadDecoder>> = {
    [OmniOpcode.NODE_CALL]: decodeNodeCallRequest,
    [OmniOpcode.PEERLIST_SYNC]: decodePeerlistSyncRequest,

    [OmniOpcode.PROPOSE_BLOCK_HASH]: decodeProposeBlockHashRequest,
    [OmniOpcode.SET_VALIDATOR_PHASE]: decodeSetValidatorPhaseRequest,
    [OmniOpcode.GREENLIGHT]: decodeGreenlightRequest,

    [OmniOpcode.MEMPOOL_SYNC]: decodeMempoolSyncRequest,
    [OmniOpcode.MEMPOOL_MERGE]: decodeMempoolMergeRequest,
    [OmniOpcode.BLOCK_SYNC]: decodeBlockSyncRequest,
    [OmniOpcode.GET_BLOCKS]: decodeBlocksRequest,
    [OmniOpcode.GET_BLOCK_BY_HASH]: decodeBlockHashRequest,
    [OmniOpcode.GET_TX_BY_HASH]: decodeTransactionHashRequest,

    [OmniOpcode.L2PS_HASH_UPDATE]: decodeL2PSHashUpdate,

    [OmniOpcode.PROTO_VERSION_NEGOTIATE]: decodeVersionNegotiateRequest,
    [OmniOpcode.PROTO_CAPABILITY_EXCHANGE]: decodeCapabilityExchangeRequest,
    [OmniOpcode.PROTO_ERROR]: decodeProtocolError,
    [OmniOpcode.PROTO_PING]: decodeProtocolPing,
    [OmniOpcode.PROTO_DISCONNECT]: decodeProtocolDisconnect,

    [RESPONSE_OPCODE]: decodeRpcResponse,
}

function truncate(rendered: string): string {
    if (rendered.length <= PAYLOAD_HEAD + PAYLOAD_TAIL + 3) {
        return rendered
    }

    return (
        rendered.slice(0, PAYLOAD_HEAD) +
        "..." +
        rendered.slice(rendered.length - PAYLOAD_TAIL)
    )
}

function hexPreview(payload: Buffer): string {
    const head = payload.subarray(0, HEX_PREVIEW_BYTES).toString("hex")
    return payload.length > HEX_PREVIEW_BYTES ? `0x${head}...` : `0x${head}`
}

export function renderPayload(opcode: number, payload: Buffer): string {
    if (!payload || payload.length === 0) {
        return "<empty>"
    }

    const decoder = DECODERS[opcode]

    if (decoder) {
        try {
            return truncate(JSON.stringify(decoder(payload)))
        } catch {
            /* empty */
        }
    }

    try {
        return truncate(JSON.stringify(decodeJsonRequest(payload)))
    } catch {
        return hexPreview(payload)
    }
}

function describeOpcode(opcode: number): string {
    const name =
        opcode === RESPONSE_OPCODE
            ? "RESPONSE"
            : opcodeToString(opcode as OmniOpcode)
    return `0x${opcode.toString(16).padStart(2, "0")}/${name}`
}

function describeAuth(auth: AuthBlock | null | undefined): string {
    if (!auth) return "none"

    const identity = auth.identity
        ? "0x" + auth.identity.toString("hex")
        : "null"
    const mode = SignatureMode[auth.signatureMode] ?? auth.signatureMode

    return `${identity}/${mode}/ts=${auth.timestamp}`
}

function describeConnection(connection: TraceConnection): string {
    return (
        `peer=${connection.peerIdentity} ` +
        `sock=${connection.socketId ?? "none"} ` +
        `origin=${connection.origin} ` +
        `from=${connection.remoteAddress ?? "unknown"}`
    )
}

function emit(site: TraceSite, fields: string): void {
    log.debug(`[OmniTrace] site=${site} ${fields}`)
}

export function traceRequest(
    connection: TraceConnection,
    header: OmniMessageHeader,
    payload: Buffer,
    auth: AuthBlock | null,
): void {
    emit(
        "request",
        `op=${describeOpcode(header.opcode)} seq=${header.sequence} ` +
            `${describeConnection(connection)} len=${header.payloadLength} ` +
            `auth=${describeAuth(auth)} ` +
            `payload=${renderPayload(header.opcode, payload)}`,
    )
}

export function traceUnmatchedResponse(
    connection: TraceConnection,
    header: OmniMessageHeader,
    payload: Buffer,
    inFlightLocal: number,
    inFlightSiblings: number,
): void {
    emit(
        "unmatched-response",
        `op=${describeOpcode(header.opcode)} seq=${header.sequence} ` +
            `${describeConnection(connection)} len=${header.payloadLength} ` +
            `inflight_local=${inFlightLocal} inflight_siblings=${inFlightSiblings} ` +
            `payload=${renderPayload(header.opcode, payload)}`,
    )
}

export function traceFramerFailure(
    kind: "checksum" | "auth-block" | "oversize",
    detail: string,
    header: OmniMessageHeader | null,
    bufferedBytes: number,
): void {
    const headerFields = header
        ? `op=${describeOpcode(header.opcode)} seq=${header.sequence} ` +
          `len=${header.payloadLength}`
        : "op=unparsed"

    emit(
        "framer",
        `kind=${kind} ${headerFields} buffered=${bufferedBytes} detail=${detail}`,
    )
}

export function traceExtractionAbort(
    connection: TraceConnection,
    error: unknown,
    strandedBytes: number,
    extractedBefore: number,
): void {
    emit(
        "extract-abort",
        `${describeConnection(connection)} stranded=${strandedBytes} ` +
            `extracted_before_abort=${extractedBefore} ` +
            `error=${error instanceof Error ? error.message : String(error)}`,
    )
}

export function traceResponseDrop(
    connection: TraceConnection,
    sequence: number,
    payloadLength: number,
    connectionsExamined: number,
): void {
    emit(
        "response-drop",
        `seq=${sequence} ${describeConnection(connection)} ` +
            `len=${payloadLength} connections_examined=${connectionsExamined}`,
    )
}
