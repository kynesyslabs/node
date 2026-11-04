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

/**
 * Whether a value can be written to a `text` or `varchar` column. The driver
 * sends an array as an array literal with its strings as they are, so U+0000
 * in one, at any depth, is refused too; an object goes as JSON.stringify
 * output, which escapes it.
 */
export function isTextStorable(value: unknown): boolean {
    const pending: unknown[] = [value]
    while (pending.length > 0) {
        const item = pending.pop()
        if (typeof item === "string") {
            if (item.includes("\u0000")) return false
        } else if (Array.isArray(item)) {
            for (const element of item) pending.push(element)
        }
    }
    return true
}

const isJsonbString = (value: string) =>
    !value.includes("\u0000") && value.isWellFormed()

/**
 * Whether a value can be a text key of a stored row, or be looked up as one.
 * Only a string can: anything else reaches the column as whatever the driver
 * makes of it (an array literal, JSON text). On top of U+0000, an unpaired
 * surrogate is refused: the driver turns it into U+FFFD, so "a\ud800" and
 * "a\udfff" are two keys in memory but one row in Postgres, and their writes
 * collide or overwrite each other.
 */
export function isKeyStorable(value: unknown): value is string {
    return typeof value === "string" && isJsonbString(value)
}

const INT8_MIN = -(2n ** 63n)
const INT8_MAX = 2n ** 63n - 1n

/** Whether `value`, as the driver sends it, is accepted by a `bigint` column. */
export function isBigintStorable(value: unknown): boolean {
    const text =
        typeof value === "bigint" || typeof value === "number" ? value.toString()
        : typeof value === "string" ? value
        : null
    if (text === null || !/^-?\d+$/.test(text)) return false
    const n = BigInt(text)
    return n >= INT8_MIN && n <= INT8_MAX
}

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
        data?: unknown
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
 * The text columns of the `l2ps_hashes` row an `l2ps_hash_update` writes when
 * its block is inserted, failed or not, or null for any other transaction.
 * Recognised exactly as the projection recognises it.
 */
export function l2psHashRowColumns(tx: TxLike): Record<string, unknown> | null {
    const content = tx?.content
    if (content?.type !== "l2ps_hash_update" || !Array.isArray(content.data)) return null
    const payload = content.data[1]
    if (
        typeof payload !== "object" ||
        payload === null ||
        !("l2ps_uid" in payload) ||
        !("consolidated_hash" in payload) ||
        !("transaction_count" in payload)
    ) {
        return null
    }
    const row = payload as Record<string, unknown>
    return { l2ps_uid: row.l2ps_uid, consolidated_hash: row.consolidated_hash }
}

/**
 * Block and sync verification: only U+0000 in a column of a row the block
 * insert writes for every transaction it lists, failed or not: the
 * transaction's own row and, for an `l2ps_hash_update`, its `l2ps_hashes`
 * row. A block carrying one never committed. A NUL elsewhere in the body sits
 * in the `json` column and did commit; the edits it implies are judged when
 * they are applied (see storableRows).
 */
export function transactionRowRefusal(tx: TxLike): string | null {
    for (const [column, value] of Object.entries(transactionRowColumns(tx))) {
        if (!isTextStorable(value)) return `Transaction ${column} ${NUL_NOT_STORABLE}`
    }
    for (const [column, value] of Object.entries(l2psHashRowColumns(tx) ?? {})) {
        if (!isTextStorable(value)) return `Transaction l2ps_hash_update ${column} ${NUL_NOT_STORABLE}`
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

/**
 * Block columns a peer serves outside the hashed content. No check binds
 * them, and the block insert writes them as served, so one Postgres refuses
 * would fail the insert on every node that accepted the block. The proposer
 * columns are NOT NULL varchars every node writes as a string: anything else
 * (null, an array the driver sends as a literal) is refused. An unpaired
 * surrogate is refused too: no honest node writes one, and the driver would
 * store a different string than the one served.
 *
 * A block in flight has no status (the Block constructor leaves it null) and
 * the insert writes "confirmed" in its place, so status may be absent; a
 * served status of any other type is still refused.
 */
export function blockRowRefusal(block: {
    proposer?: unknown
    next_proposer?: unknown
    status?: unknown
}): string | null {
    for (const column of ["proposer", "next_proposer", "status"] as const) {
        const value = block?.[column]
        if (column === "status" && (value === null || value === undefined)) continue
        if (typeof value !== "string") return `Block ${column} is not a string`
        if (!isKeyStorable(value)) return `Block ${column} ${NOT_STORABLE}`
    }
    return null
}
