/**
 * What Postgres refuses to store, as seen from JavaScript strings:
 *
 * - `jsonb` refuses U+0000 and any unpaired UTF-16 surrogate, in values and
 *   keys alike (the driver sends JSON.stringify output, whose `\u0000` and
 *   `\ud800` escapes jsonb rejects).
 * - `text`/`varchar` refuse U+0000. An unpaired surrogate is not refused: the
 *   driver encodes it as U+FFFD, so the row is written, lossily.
 * - `json` stores the text as given and refuses neither.
 *
 * A refused value fails the block's database transaction on every node.
 * Admission refuses anything a transaction carries that would not survive
 * jsonb. Block and sync verification must not reject history that did
 * commit, so they refuse only what reaches a column that refuses it.
 *
 * No imports: the validator workers load this file.
 */

export const NOT_STORABLE =
    "cannot contain U+0000 or an unpaired UTF-16 surrogate, which Postgres cannot store"

export const NUL_NOT_STORABLE = "cannot contain U+0000, which Postgres cannot store"

/** Whether a string can be written to a `text` or `varchar` column. */
export function isTextStorable(value: unknown): boolean {
    return typeof value !== "string" || !value.includes("\u0000")
}

const isJsonbString = (value: string) =>
    !value.includes("\u0000") && value.isWellFormed()

/**
 * Whether a JSON-shaped value can be written to a `jsonb` column: no string
 * or key holds U+0000 or an unpaired surrogate. Walked without recursion: the
 * value may come from a transaction nested deeper than the call stack.
 */
export function isJsonbStorable(value: unknown): boolean {
    const pending: unknown[] = [value]
    while (pending.length > 0) {
        const item = pending.pop()
        if (typeof item === "string") {
            if (!isJsonbString(item)) return false
            continue
        }
        if (typeof item !== "object" || item === null) continue
        if (ArrayBuffer.isView(item)) continue
        if (Array.isArray(item)) {
            for (const element of item) pending.push(element)
            continue
        }
        for (const [key, element] of Object.entries(item)) {
            if (!isJsonbString(key)) return false
            pending.push(element)
        }
    }
    return true
}

/**
 * Admission: the whole transaction, any depth. What it carries ends up in
 * jsonb rows through the edits it implies, so nothing that jsonb refuses is
 * let in.
 */
export function admissionRefusal(tx: unknown): string | null {
    return isJsonbStorable(tx) ? null : `Transaction ${NOT_STORABLE}`
}

type TxLike = {
    hash?: unknown
    status?: unknown
    ed25519_signature?: unknown
    blockNumber?: unknown
    content?: {
        type?: unknown
        from?: unknown
        from_ed25519_address?: unknown
        to?: unknown
        amount?: unknown
        nonce?: unknown
        timestamp?: unknown
        transaction_fee?: {
            network_fee?: unknown
            rpc_fee?: unknown
            additional_fee?: unknown
            rpc_address?: unknown
        }
    }
}

/**
 * The values a `transactions` row copies out of a transaction into columns
 * that are neither `json` nor `jsonb`, by column name. `signature` is left out:
 * it is stored as JSON.stringify output, which escapes U+0000. `content` is
 * `json` and `attrs` is node-written jsonb, cleaned before it is stored.
 * Kept in step with the entity by a test.
 */
export function transactionRowColumns(tx: TxLike): Record<string, unknown> {
    const content = tx?.content ?? {}
    const fee = content.transaction_fee ?? {}
    return {
        blockNumber: tx?.blockNumber,
        ed25519_signature: tx?.ed25519_signature,
        status: tx?.status,
        hash: tx?.hash,
        type: content.type,
        from: content.from,
        from_ed25519_address: content.from_ed25519_address,
        to: content.to,
        amount: content.amount,
        nonce: content.nonce,
        timestamp: content.timestamp,
        networkFee: fee.network_fee,
        rpcFee: fee.rpc_fee,
        additionalFee: fee.additional_fee,
        rpcAddress: fee.rpc_address,
    }
}

/**
 * Block and sync verification: only U+0000 in a column of the transaction's
 * own row. Such a row is written for every transaction a block lists, failed
 * or not, so a block carrying one never committed. A NUL elsewhere in the
 * body sits in the `json` column and did commit; the edits it implies are
 * judged when they are applied (see storableRows).
 */
export function transactionRowRefusal(tx: TxLike): string | null {
    for (const [column, value] of Object.entries(transactionRowColumns(tx))) {
        if (!isTextStorable(value)) return `Transaction ${column} ${NUL_NOT_STORABLE}`
    }
    return null
}

const storableString = (value: string) =>
    value.replaceAll("\u0000", "�").toWellFormed()

/**
 * The value with U+0000 and unpaired surrogates replaced by U+FFFD in every
 * string and key, for node-written metadata (`attrs`) that may quote
 * transaction input. The metadata is not covered by any hash, so rewriting it
 * changes nothing a peer checks. A storable value is returned as is.
 */
export function withStorableText<T>(value: T): T {
    if (isJsonbStorable(value)) return value
    const root: { value: unknown } = { value: undefined }
    const pending: Array<[unknown, Record<string | number, unknown>, string | number]> = [
        [value, root as Record<string, unknown>, "value"],
    ]
    while (pending.length > 0) {
        const [item, parent, slot] = pending.pop()!
        if (typeof item === "string") {
            parent[slot] = storableString(item)
        } else if (Array.isArray(item)) {
            const copy: unknown[] = new Array(item.length)
            parent[slot] = copy
            item.forEach((element, i) => pending.push([element, copy as never, i]))
        } else if (typeof item === "object" && item !== null && !ArrayBuffer.isView(item)) {
            const copy: Record<string, unknown> = {}
            parent[slot] = copy
            for (const [key, element] of Object.entries(item)) {
                pending.push([element, copy, storableString(key)])
            }
        } else {
            parent[slot] = item
        }
    }
    return root.value as T
}
