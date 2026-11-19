import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { serializeBlockContent, serializeTransactionContent } from "@/forks"
import Hashing from "src/libs/crypto/hashing"
import { certificateMessageOf } from "src/libs/consensus/v2/commitLock/domain"
import { previousRuleHeights } from "src/libs/blockchain/referenceBlockWindow"
import {
    isSystemRelayTx,
    systemRelayContentString,
} from "src/libs/blockchain/validation/systemRelayTx"

/**
 * A block as a finality proof carries it: the exact text its hash is the
 * sha256 of, so a client checks the hash and reads the commitments from
 * signed bytes, never from a re-encoding of its own.
 */
export interface BlockBytes {
    number: number
    hash: string
    contentBytes: string
}

/** A block with its certificate: what a client checks a quorum on. */
export interface SignedHeader extends BlockBytes {
    round: number | null
    signedMessage: string | null
    signatures: Record<string, string>
}

interface StoredBlock {
    number: number
    hash: string
    content: unknown
    validation_data?: { signatures?: Record<string, string>; round?: unknown } | null
}

/**
 * A transaction as a proof carries it: the exact text its hash is the sha256
 * of, and the signature the sender made, so a client reads the fields from
 * hashed bytes instead of re-encoding a stored row.
 */
export interface TransactionBytes {
    hash: string
    contentBytes: string
    signature: { type: string; data: string; domain?: string } | null
    ed25519_signature: string | null
}

/**
 * The stored content of a block, or of a transaction in it, no longer
 * hashes to the stored hash.
 */
export class ContentUnrecoverableError extends Error {
    constructor(
        readonly blockNumber: number,
        readonly txHash?: string,
    ) {
        super(
            txHash
                ? `content of transaction ${txHash} in block ${blockNumber} does not hash to its hash`
                : `content of block ${blockNumber} does not hash to its stored hash`,
        )
        this.name = "ContentUnrecoverableError"
    }
}

/**
 * @throws ContentUnrecoverableError when the bytes re-serialized from the
 *   stored content do not hash to the stored hash: serving them would hand
 *   the client a proof that cannot verify.
 */
export function blockBytes(block: StoredBlock): BlockBytes {
    const contentBytes = serializeBlockContent(block.content as never, block.number)
    if (Hashing.sha256(contentBytes) !== block.hash) {
        throw new ContentUnrecoverableError(block.number)
    }
    return { number: block.number, hash: block.hash, contentBytes }
}

interface StoredTransaction {
    hash: string
    content: unknown
    signature?: { type: string; data: string; domain?: string } | null
    ed25519_signature?: string | null
}

/**
 * The texts block sync accepts as hashing to a transaction of block m: a
 * system relay type hashes its raw content; any other type is serialized at
 * the rules of m, or of a height before a fork that activated within the deep
 * window, since a transaction admitted under the old rule can still land in
 * a block after the fork.
 */
function hashPreimages(tx: StoredTransaction, blockNumber: number): string[] {
    if (isSystemRelayTx(tx as never)) return [systemRelayContentString(tx.content)]
    const texts: string[] = []
    for (const height of [blockNumber, ...previousRuleHeights(blockNumber)]) {
        try {
            const text = serializeTransactionContent(tx.content as never, height)
            if (!texts.includes(text)) texts.push(text)
        } catch {
            // Content that this rule cannot serialize was not admitted under it.
        }
    }
    return texts
}

/**
 * The transaction as validation hashed it, so the bytes a client hashes are
 * the ones the block committed to.
 *
 * @throws ContentUnrecoverableError when no accepted serialization of the
 *   stored content hashes to the transaction's hash.
 */
export function transactionBytes(tx: StoredTransaction, blockNumber: number): TransactionBytes {
    const contentBytes = hashPreimages(tx, blockNumber).find(text => Hashing.sha256(text) === tx.hash)
    if (contentBytes === undefined) {
        throw new ContentUnrecoverableError(blockNumber, tx.hash)
    }
    return {
        hash: tx.hash,
        contentBytes,
        signature: tx.signature ?? null,
        ed25519_signature: tx.ed25519_signature ?? null,
    }
}

export function signedHeader(block: StoredBlock): SignedHeader {
    const round = block.validation_data?.round
    return {
        ...blockBytes(block),
        round: typeof round === "number" ? round : null,
        signedMessage: certificateMessageOf(block),
        signatures: block.validation_data?.signatures ?? {},
    }
}

export function answer(response: unknown): RPCResponse {
    return { result: 200, response, extra: "", require_reply: false }
}

/** A refusal: the reason goes in `extra`, the body names it for SDK clients. */
export function refusal(
    result: number,
    reason: string,
    response: Record<string, unknown> = {},
): RPCResponse {
    return {
        result,
        response: { error: reason, ...response },
        extra: { reason },
        require_reply: false,
    }
}

/** 500 content_unrecoverable for that error, 500 lookup_failed for any other. */
export function failedRead(error: unknown): RPCResponse {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof ContentUnrecoverableError) {
        return {
            result: 500,
            response: {
                error: "content_unrecoverable",
                blockNumber: error.blockNumber,
                ...(error.txHash ? { txHash: error.txHash } : {}),
            },
            extra: { reason: "content_unrecoverable", error: message },
            require_reply: false,
        }
    }
    return {
        result: 500,
        response: { error: "INTERNAL_ERROR" },
        extra: { reason: "lookup_failed", error: message },
        require_reply: false,
    }
}

/** A non-negative block number, given as a number or its digits. */
export function toBlockNumber(value: unknown): number | null {
    const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null
}
