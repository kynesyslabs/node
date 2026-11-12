/**
 * The settlement opening of a member-decrypted L2PS transfer: what admission
 * checks and the aggregator plans from. Spec: docs/design/l2ps-zk-settlement.md,
 * "Interface v1 → Transaction" (the encrypted inner transfer).
 *
 * Inner transfer, as the SDK builds it: a native send whose `data[1]` is
 *   { nativeOperation: "send", args: [to, "<OS decimal>"], l2ps_uid,
 *     settlement: { fee: "<OS decimal>", salt: "0x" + 64 hex,
 *                   commitment: "0x" + 64 hex, signature: "0x" + 128 hex } }
 * and whose `content.nonce` is the settlement nonce.
 */
import {
    AMOUNT_LIMIT,
    NONCE_LIMIT,
    SALT_BYTES,
    SETTLEMENT_TRANSFERS,
    hexToField,
    parseUnsigned,
    settlementCommitment,
    settlementSignatureMessage,
    SettlementEncodingError,
} from "./encoding"
import type { DecryptedTransfer } from "./types"
import { verifyEd25519 } from "./ed25519"
import { BLOCK_MAX_CONTENT_BYTES } from "@/utilities/constants"

const ACCOUNT = /^0x[0-9a-f]{64}$/
const FIELD_HEX = /^0x[0-9a-f]{64}$/
const SIGNATURE_HEX = /^0x[0-9a-f]{128}$/
const SALT_LIMIT = 1n << BigInt(8 * SALT_BYTES)

export type TransferVerdict =
    | { ok: true; transfer: DecryptedTransfer }
    | { ok: false; reason: string }

interface InnerTx {
    hash?: string
    content?: {
        type?: unknown
        from?: unknown
        nonce?: unknown
        data?: unknown
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseNonce(value: unknown): bigint {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new SettlementEncodingError("nonce is not a non-negative integer")
        }
        return BigInt(value)
    }
    if (typeof value === "string") return parseUnsigned(value, NONCE_LIMIT, "nonce")
    throw new SettlementEncodingError("nonce is missing")
}

/**
 * The transfer an inner L2PS transaction opens, with its commitment
 * recomputed from the decrypted fields and compared with the one it carries.
 * `txHash` is the hash of the encrypted transaction carrying it.
 *
 * A transfer without `settlement` is the format before `l2psSettlement`;
 * the refusal says so, since it is what an outdated SDK sends.
 */
export function openSettlementTransfer(inner: InnerTx, txHash: string): TransferVerdict {
    const refuse = (reason: string): TransferVerdict => ({ ok: false, reason })
    const content = inner?.content
    const data = content?.data
    if (content?.type !== "native" || !Array.isArray(data) || data[0] !== "native") {
        return refuse("an L2PS transfer must be a native send")
    }
    const payload = data[1]
    if (!isPlainObject(payload) || payload.nativeOperation !== "send") {
        return refuse("an L2PS transfer must be a native send")
    }
    const settlement = payload.settlement
    if (!isPlainObject(settlement)) {
        return refuse(
            "old-format L2PS transfer: the l2psSettlement fork requires data[1].settlement " +
                "{ fee, salt, commitment, signature }; update the SDK",
        )
    }
    const args = payload.args
    if (!Array.isArray(args) || args.length < 2) return refuse("native send has no [to, amount] args")
    const [to, amount] = args
    const from = content.from
    if (typeof from !== "string" || !ACCOUNT.test(from)) {
        return refuse("sender is not a canonical account (0x + 64 lowercase hex)")
    }
    if (typeof to !== "string" || !ACCOUNT.test(to)) {
        return refuse("receiver is not a canonical account (0x + 64 lowercase hex)")
    }
    if (typeof amount !== "string") return refuse("amount must be an OS decimal string")
    const { fee, salt, commitment, signature } = settlement
    if (typeof fee !== "string") return refuse("settlement fee must be an OS decimal string")
    if (typeof salt !== "string" || !FIELD_HEX.test(salt)) {
        return refuse("settlement salt must be 0x + 64 lowercase hex")
    }
    if (typeof commitment !== "string" || !FIELD_HEX.test(commitment)) {
        return refuse("settlement commitment must be 0x + 64 lowercase hex")
    }
    if (typeof signature !== "string" || !SIGNATURE_HEX.test(signature)) {
        return refuse("settlement signature must be 0x + 128 lowercase hex")
    }

    try {
        const opened = {
            from,
            to,
            amount: parseUnsigned(amount, AMOUNT_LIMIT, "amount"),
            fee: parseUnsigned(fee, AMOUNT_LIMIT, "fee"),
            nonce: parseNonce(content.nonce),
            salt: hexToField(salt),
        }
        if (opened.salt >= SALT_LIMIT) return refuse("settlement salt is not below 2^248")
        const recomputed = settlementCommitment(opened)
        if (recomputed !== hexToField(commitment)) {
            return refuse("settlement commitment does not open to the decrypted transfer")
        }
        return {
            ok: true,
            transfer: { txHash, ...opened, commitment: recomputed, signature },
        }
    } catch (error) {
        if (error instanceof SettlementEncodingError) return refuse(error.message)
        throw error
    }
}

/** Whether the sender signed the transfer's commitment for this chain and subnet. */
export function transferSignatureRefusal(
    transfer: DecryptedTransfer,
    chainId: number | null,
    l2psUid: string,
): string | null {
    if (chainId === null) return "the chain declares no id to bind settlement signatures to"
    let message: Uint8Array
    try {
        message = settlementSignatureMessage(chainId, l2psUid, transfer.commitment)
    } catch (error) {
        return (error as Error).message
    }
    return verifyEd25519(message, transfer.signature, transfer.from)
        ? null
        : "settlement signature does not verify for the sender"
}

/**
 * Member admission of a settlement transfer: the opening, the signature, a
 * fee of at least the native transfer fee and a nonce the account has not
 * spent. The planner judges balances and nonce order at batch time.
 */
export function transferAdmissionRefusal(
    transfer: DecryptedTransfer,
    context: {
        chainId: number | null
        l2psUid: string
        minimumFee: bigint
        accountNonce: bigint
    },
): string | null {
    const signature = transferSignatureRefusal(transfer, context.chainId, context.l2psUid)
    if (signature) return signature
    if (transfer.fee < context.minimumFee) {
        return `settlement fee ${transfer.fee} is below the native transfer fee ${context.minimumFee}`
    }
    if (transfer.nonce < context.accountNonce + 1n) {
        return `settlement nonce ${transfer.nonce} is already spent (account nonce ${context.accountNonce})`
    }
    return null
}

/**
 * How far past its account nonce a sender may queue transfers: two full
 * batches. A constant, so every member admits the same transfers.
 */
export const MAX_NONCE_AHEAD = 2n * BigInt(SETTLEMENT_TRANSFERS)

/**
 * Bytes a batch row adds around its envelope: the row's hash and original
 * hash with their JSON keys (about 180) and the array's separators.
 */
const BATCH_ROW_WRAPPER_BYTES = 256

/**
 * Most bytes of a stored L2PS envelope (the outer transaction, as JSON) a
 * member admits for settlement. A batch carries up to SETTLEMENT_TRANSFERS
 * rows, each an envelope in its row wrapper, as base64 JSON, which grows
 * them by a third; a full batch of them stays within half of an empty block,
 * so its record, proof and the block's other txs still fit. A larger
 * envelope would make every batch it joins too big for the mempool.
 */
export const SETTLEMENT_ENVELOPE_MAX_BYTES =
    Math.floor(((BLOCK_MAX_CONTENT_BYTES / 2) * 3) / 4 / SETTLEMENT_TRANSFERS) - BATCH_ROW_WRAPPER_BYTES

export function envelopeSizeRefusal(envelope: unknown): string | null {
    const bytes = Buffer.byteLength(JSON.stringify(envelope) ?? "")
    return bytes > SETTLEMENT_ENVELOPE_MAX_BYTES
        ? `L2PS envelope is ${bytes} bytes, over the ${SETTLEMENT_ENVELOPE_MAX_BYTES} a settlement batch can carry`
        : null
}

/** A transfer this member already queued for the sender and has not settled. */
export interface QueuedTransfer {
    nonce: bigint
    amount: bigint
    fee: bigint
}

/**
 * Admission against what the sender already has queued here: a nonce within
 * MAX_NONCE_AHEAD of the account nonce and not queued yet, and a balance
 * that covers every queued transfer still to settle plus this one. Without
 * these one sender could fill the subnet's queue with transfers that can
 * never be placed in a batch.
 */
export function queueAdmissionRefusal(
    transfer: DecryptedTransfer,
    sender: { balance: bigint; nonce: bigint },
    queued: QueuedTransfer[],
): string | null {
    const limit = sender.nonce + MAX_NONCE_AHEAD
    if (transfer.nonce > limit) {
        return `settlement nonce ${transfer.nonce} is more than ${MAX_NONCE_AHEAD} past the account nonce ${sender.nonce}`
    }
    let committed = 0n
    for (const q of queued) {
        if (q.nonce <= sender.nonce) continue
        if (q.nonce === transfer.nonce) {
            return `a transfer with settlement nonce ${transfer.nonce} is already queued for this sender`
        }
        committed += q.amount + q.fee
    }
    const need = committed + transfer.amount + transfer.fee
    if (sender.balance < need) {
        return `Insufficient balance: need ${need} (queued transfers, amount and fee) but have ${sender.balance}`
    }
    return null
}
