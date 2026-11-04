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

/**
 * The UTF-8 bytes a text key of a b-tree index may hold, as this node judges
 * it. Postgres refuses an index entry over 2704 bytes ("index row size
 * exceeds btree version 4 maximum 2704") after trying to compress it, so
 * whether a longer key fails depends on its content and on the node's
 * compression setting. Capped well below, on the length alone, every node
 * judges a key alike, and an index over two such keys still fits.
 */
export const INDEX_KEY_MAX_BYTES = 1024

/**
 * Whether `value`, as the driver sends it, fits a b-tree index entry under
 * `maxBytes`. A string is measured in UTF-8, an unpaired surrogate as the
 * U+FFFD the driver sends; a number, boolean or null is short; anything else
 * by its JSON text, which is what (or about what) the driver sends.
 */
export function fitsIndexKey(value: unknown, maxBytes: number = INDEX_KEY_MAX_BYTES): boolean {
    if (typeof value === "string") return utf8Length(value) <= maxBytes
    if (value === null || value === undefined) return true
    if (typeof value === "number" || typeof value === "boolean") return true
    if (typeof value === "bigint") return value.toString().length <= maxBytes
    let text: string | undefined
    try {
        text = JSON.stringify(value)
    } catch {
        return false
    }
    return text === undefined || utf8Length(text) <= maxBytes
}

/** UTF-8 length of `value`, an unpaired surrogate counted as U+FFFD. */
export function utf8Length(value: string): number {
    let bytes = 0
    for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i)
        if (unit < 0x80) bytes += 1
        else if (unit < 0x800) bytes += 2
        else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length) {
            const next = value.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4
                i++
            } else {
                bytes += 3
            }
        } else bytes += 3
    }
    return bytes
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

/** The bytes Postgres' integer input skips around a number (C isspace). */
const PG_SPACE = new Set([" ", "\t", "\n", "\v", "\f", "\r"])

const RADIX_DIGITS: Record<number, RegExp> = {
    2: /^[01]$/,
    8: /^[0-7]$/,
    10: /^[0-9]$/,
    16: /^[0-9a-fA-F]$/,
}

const RADIX_PREFIX: Record<string, number> = { x: 16, X: 16, o: 8, O: 8, b: 2, B: 2 }

/**
 * Whether Postgres 16 reads `text` as an int8 (pg_strtoint64_safe):
 * whitespace around it, an optional sign, then decimal digits or a 0x/0o/0b
 * prefix and digits of that base, single underscores between digits (and
 * after a prefix), and a value in range. Leading zeros are allowed. No
 * decimal point, no exponent. Confirmed against the pinned postgres:16
 * image; see postgresStorable.rowInsert.test.ts.
 */
export function isInt8Text(text: string): boolean {
    let i = 0
    while (i < text.length && PG_SPACE.has(text[i])) i++
    let negative = false
    if (text[i] === "-") {
        negative = true
        i++
    } else if (text[i] === "+") {
        i++
    }
    let radix = 10
    if (text[i] === "0" && Object.hasOwn(RADIX_PREFIX, text[i + 1] ?? "")) {
        radix = RADIX_PREFIX[text[i + 1]]
        i += 2
    }
    const isDigit = (c: string | undefined) => c !== undefined && RADIX_DIGITS[radix].test(c)
    const first = i
    let digits = ""
    while (i < text.length) {
        if (isDigit(text[i])) {
            digits += text[i++]
        } else if (text[i] === "_") {
            if (radix === 10 && i === first) return false
            i++
            if (!isDigit(text[i])) return false
        } else {
            break
        }
    }
    if (digits === "") return false
    while (i < text.length && PG_SPACE.has(text[i])) i++
    if (i !== text.length) return false
    // Past 64 significant digits no base fits int8; BigInt is not asked to
    // parse a long one.
    const significant = digits.replace(/^0+/, "")
    if (significant.length > 64) return false
    const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : radix === 2 ? "0b" : ""
    const magnitude = significant === "" ? 0n : BigInt(prefix + significant)
    const value = negative ? -magnitude : magnitude
    return value >= INT8_MIN && value <= INT8_MAX
}

/**
 * Whether a `bigint` column takes `value` as the driver sends it: a number
 * as its toString() (so 1e21 arrives as "1e+21"), a string as is. A boolean
 * arrives as "true", an object as JSON text and an array as an array
 * literal, none of which int8 reads. `undefined` is left out of the insert,
 * so the column default applies; null is NULL.
 */
function isInt8ColumnValue(
    value: unknown,
    column: { nullable: boolean; hasDefault: boolean },
): boolean {
    if (value === undefined) return column.hasDefault || column.nullable
    if (value === null) return column.nullable
    if (typeof value === "number" || typeof value === "bigint") return isInt8Text(value.toString())
    if (typeof value === "string") return isInt8Text(value)
    return false
}

/** numeric(38, 0) holds up to 38 digits. */
const NUMERIC_38_LIMIT = 10n ** 38n

/**
 * The bigint the block insert makes of an amount or fee (toEntityBigint in
 * transaction.ts: null and undefined are 0, anything else goes through
 * BigInt()), or undefined where that throws. JavaScript's grammar decides
 * here, not Postgres': the column receives the bigint's decimal text.
 */
export function entityBigint(value: unknown): bigint | undefined {
    if (value === null || value === undefined) return 0n
    if (typeof value === "bigint") return value
    if (typeof value === "boolean") return value ? 1n : 0n
    if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : undefined
    let text: string
    if (typeof value === "string") {
        text = value
    } else if (Array.isArray(value)) {
        // BigInt reads an array as its join(), which throws on an element
        // with its own toString.
        try {
            text = String(value)
        } catch {
            return undefined
        }
    } else {
        // A plain object reads as "[object Object]" or throws.
        return undefined
    }
    // Over 130 significant digits no base is below 10^38, so a long string
    // is refused without asking BigInt to parse it. trim() drops what
    // BigInt skips.
    const significant = text
        .trim()
        .replace(/^[+-]/, "")
        .replace(/^0[xXoObB]/, "")
        .replace(/^0+/, "")
    if (significant.length > 130) return undefined
    try {
        return BigInt(text)
    } catch {
        return undefined
    }
}

/**
 * What the block insert stores for `to` or `from` (toRawTransaction): a
 * value whose `data` stringifies to something non-empty with
 * toString("hex") (a Buffer, or its JSON form, read as its join()) is
 * replaced by that string, anything else is kept. Throws where
 * toRawTransaction throws: on null or undefined, on a numeric `data` (no
 * radix "hex"), and on a `data` or array element with its own toString.
 */
export function storedAddress(value: unknown): unknown {
    const converted = (value as Record<string, any>)["data"]?.toString("hex")
    return converted ? converted : value
}

const storedAddressOrRaw = (value: unknown): unknown => {
    try {
        return storedAddress(value)
    } catch {
        return value
    }
}

/**
 * Nesting the values copied into the row's own columns may have. Turning
 * one into text recurses (Array.prototype.join, the driver's array literal,
 * JSON.stringify), and how deep that gets before the stack runs out
 * depends on the thread and its stack: about 3,400 levels for join in a
 * validator worker, 4,300 on the main thread. Checked against that, a
 * value could pass in the worker and fail the block insert. Honest values
 * are scalars, a signature object or a Buffer's JSON form.
 */
export const ROW_VALUE_MAX_DEPTH = 256

/** Whether arrays and objects in `value` nest deeper than `max`. */
export function nestsDeeperThan(value: unknown, max: number): boolean {
    const pending: Array<[unknown, number]> = [[value, 0]]
    while (pending.length > 0) {
        const [item, depth] = pending.pop()!
        if (typeof item !== "object" || item === null) continue
        if (depth + 1 > max) return true
        if (ArrayBuffer.isView(item)) continue
        for (const element of Array.isArray(item) ? item : Object.values(item)) {
            if (typeof element === "object" && element !== null) pending.push([element, depth + 1])
        }
    }
    return false
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
    signature?: unknown
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
 * that are neither `json` nor `jsonb`, by column name, `to` and `from` as
 * the insert converts them. `signature` is left out: it is stored as
 * JSON.stringify output, which escapes U+0000. `content` is `json` and
 * `attrs` is node-written jsonb, cleaned before it is stored. Kept in step
 * with the entity by a test.
 */
export function transactionRowColumns(tx: TxLike): Record<string, unknown> {
    return rowColumns(tx, storedAddressOrRaw)
}

function rowColumns(tx: TxLike, address: (value: unknown) => unknown): Record<string, unknown> {
    const content = tx?.content ?? {}
    const fee = content.transaction_fee ?? {}
    return {
        blockNumber: tx?.blockNumber,
        ed25519_signature: tx?.ed25519_signature,
        status: tx?.status,
        hash: tx?.hash,
        type: content.type,
        from: address(content.from),
        from_ed25519_address: content.from_ed25519_address,
        to: address(content.to),
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
 * What the block insert of the `transactions` row throws on, so that a
 * block carrying it never committed: a dereference toRawTransaction makes
 * of a missing value (`to`, `from`, `transaction_fee`), a NOT NULL column
 * left NULL (`type`, `hash`, `signature`, `timestamp`), an int8 column
 * Postgres cannot read (`timestamp`, `nonce`), and an amount or fee
 * BigInt() cannot read or numeric(38, 0) cannot hold. Nothing stricter:
 * history that committed passes. `status` and `blockNumber` are written by
 * this node before the insert, not taken from the transaction.
 *
 * Mirrors toRawTransaction and toTransactionsEntity in transaction.ts;
 * a test runs both on the refused values.
 */
export function transactionRowValueRefusal(tx: TxLike): string | null {
    const content = tx?.content
    const nested = { ...rowColumns(tx, value => value), signature: tx?.signature }
    for (const [column, value] of Object.entries(nested)) {
        if (nestsDeeperThan(value, ROW_VALUE_MAX_DEPTH)) {
            return `Transaction ${column} nests deeper than ${ROW_VALUE_MAX_DEPTH} levels`
        }
    }
    for (const column of ["to", "from"] as const) {
        const value = content?.[column]
        if (value === null || value === undefined) return `Transaction ${column} is missing`
        try {
            storedAddress(value)
        } catch {
            return `Transaction ${column} cannot be read as an address`
        }
    }
    const fee = content?.transaction_fee
    if (fee === null || fee === undefined) return "Transaction transaction_fee is missing"
    if (content?.type === null || content?.type === undefined) return "Transaction type is missing"
    if (tx?.hash === null || tx?.hash === undefined) return "Transaction hash is missing"
    // JSON.stringify(undefined) is undefined, which leaves the NOT NULL
    // column to its absent default; null is stored as "null".
    if (tx?.signature === undefined) return "Transaction signature is missing"
    if (!isInt8ColumnValue(content?.timestamp, { nullable: false, hasDefault: false })) {
        return "Transaction timestamp is not an int8 Postgres reads"
    }
    if (!isInt8ColumnValue(content?.nonce, { nullable: true, hasDefault: true })) {
        return "Transaction nonce is not an int8 Postgres reads"
    }
    const money = {
        amount: content?.amount,
        network_fee: fee.network_fee,
        rpc_fee: fee.rpc_fee,
        additional_fee: fee.additional_fee,
    }
    for (const [field, value] of Object.entries(money)) {
        const n = entityBigint(value)
        if (n === undefined) return `Transaction ${field} is not an integer`
        if (n >= NUMERIC_38_LIMIT || n <= -NUMERIC_38_LIMIT) {
            return `Transaction ${field} has more than the 38 digits its column holds`
        }
    }
    return null
}

/** Columns of the `transactions` row a b-tree index covers. */
const INDEXED_TRANSACTION_COLUMNS = ["hash", "from_ed25519_address", "to"] as const

/**
 * Block and sync verification: only what fails the rows the block insert
 * writes for every transaction it lists, failed or not: a value the
 * `transactions` row cannot be built from or Postgres refuses there (see
 * transactionRowValueRefusal), U+0000 in that row and, for an
 * `l2ps_hash_update`, its `l2ps_hashes` row, and an indexed value too long
 * for its b-tree entry. A block carrying one never committed. A NUL elsewhere in the body sits in the `json` column
 * and did commit; the edits it implies are judged when they are applied (see
 * storableRows). The l2ps_hashes uid is not capped here: a row that does not
 * fit is skipped, not written.
 *
 * The sender a transaction is assigned to, its ed25519 address or else its
 * `from`, keys a row of `gcr_assigned_txs` and is capped too. Only a system
 * relay transaction can lack the address; the one honest nodes write carries
 * it.
 *
 * `to` is held to its format at admission, not here: the node admitted other
 * spellings before, and blocks that carry them committed.
 */
export function transactionRowRefusal(tx: TxLike): string | null {
    const unwritable = transactionRowValueRefusal(tx)
    if (unwritable !== null) return unwritable
    const columns = transactionRowColumns(tx)
    for (const [column, value] of Object.entries(columns)) {
        if (!isTextStorable(value)) return `Transaction ${column} ${NUL_NOT_STORABLE}`
    }
    for (const column of INDEXED_TRANSACTION_COLUMNS) {
        if (!fitsIndexKey(columns[column])) {
            return `Transaction ${column} is longer than ${INDEX_KEY_MAX_BYTES} bytes, more than its index holds`
        }
    }
    const sender = tx?.content?.from_ed25519_address || tx?.content?.from
    if (!fitsIndexKey(sender)) {
        return `Transaction sender is longer than ${INDEX_KEY_MAX_BYTES} bytes, more than its index holds`
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
