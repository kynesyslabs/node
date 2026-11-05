import { getMetadataArgsStorage } from "typeorm"

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { GCRAtomicWork } from "@/model/entities/GCRv2/GCR_AtomicWork"
import { Validators } from "@/model/entities/Validators"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import {
    NOT_STORABLE,
    fitsIndexKey,
    isJsonbStorable,
    isKeyStorable,
    isTextStorable,
} from "@/libs/blockchain/validation/postgresStorable"

/**
 * Whether the rows an edit leaves behind can be written by the block.
 *
 * An edit that puts U+0000 into a text column, or U+0000 or an unpaired
 * surrogate into a jsonb column, does not fail when it is applied: it fails
 * the block's commit, on every node. Checking the row the edit produced,
 * column by column, fails the transaction instead, and only where the commit
 * would have failed: a value the routine did not store, or stored in a json
 * column, was committed before and still is.
 */

type ColumnKind = "text" | "indexedText" | "jsonb" | "other"

const TEXT_TYPES = new Set(["text", "varchar", "character varying", "char", "character", "citext", "uuid", "enum"])

const kindsByEntity = new Map<Function, Map<string, ColumnKind>>()

/** Properties of `entity` that a primary key, unique constraint or index covers. */
export function indexedColumns(entity: Function): Set<string> {
    const storage = getMetadataArgsStorage()
    const indexed = new Set<string>()
    for (const column of storage.columns) {
        if (column.target !== entity) continue
        if (column.options.primary || column.options.unique) indexed.add(column.propertyName)
    }
    for (const index of [...storage.indices, ...storage.uniques]) {
        if (index.target !== entity || !Array.isArray(index.columns)) continue
        for (const property of index.columns) indexed.add(property)
    }
    return indexed
}

function columnKind(type: unknown, indexed: boolean): ColumnKind {
    let name = ""
    if (typeof type === "string") name = type.toLowerCase()
    else if (type === String) name = "varchar"
    if (name === "jsonb") return "jsonb"
    if (!TEXT_TYPES.has(name)) return "other"
    return indexed ? "indexedText" : "text"
}

function columnKinds(entity: Function): Map<string, ColumnKind> {
    let kinds = kindsByEntity.get(entity)
    if (kinds) return kinds
    kinds = new Map()
    const indexed = indexedColumns(entity)
    for (const column of getMetadataArgsStorage().columns) {
        if (column.target !== entity) continue
        kinds.set(column.propertyName, columnKind(column.options.type, indexed.has(column.propertyName)))
    }
    kindsByEntity.set(entity, kinds)
    return kinds
}

/** Indexed text values a row holds, by property, as `unstorableColumn` takes them back. */
export type IndexedValues = Record<string, unknown>

/**
 * The first column of `row`, stored as `entity`, that Postgres would refuse:
 * U+0000 in text, what jsonb refuses, or an indexed text value too long for
 * its b-tree entry.
 *
 * The index cap is this node's rule, stricter than Postgres, and older nodes
 * stored longer values (a snapshot import copies them as they are). Such a
 * value, passed in `stored` as the row held it before the edit, is not
 * judged again while the edit leaves it unchanged: the edit writes nothing
 * new to that index, and refusing it would leave the row with no edit, ACL
 * change or delete that applies. The cap still holds for every value an edit
 * writes.
 */
export function unstorableColumn(entity: Function, row: unknown, stored?: IndexedValues): string | null {
    if (typeof row !== "object" || row === null) return null
    for (const [property, kind] of columnKinds(entity)) {
        const value = (row as Record<string, unknown>)[property]
        if ((kind === "text" || kind === "indexedText") && !isTextStorable(value)) return property
        if (kind === "indexedText" && !fitsIndexKey(value) && !keptAsStored(stored, property, value)) {
            return property
        }
        if (kind === "jsonb" && !isJsonbStorable(value)) return property
    }
    return null
}

function keptAsStored(stored: IndexedValues | undefined, property: string, value: unknown): boolean {
    return stored !== undefined && Object.hasOwn(stored, property) && stored[property] === value
}

/** The indexed text values of `row` of `cache`, or undefined for a row it has none of. */
export function indexedValues(cache: string, row: unknown): IndexedValues | undefined {
    const entity = ROW_ENTITIES[cache]
    if (entity === undefined || entity === "jsonb" || typeof row !== "object" || row === null) return undefined
    const values: IndexedValues = {}
    for (const [property, kind] of columnKinds(entity)) {
        if (kind === "indexedText") values[property] = (row as Record<string, unknown>)[property]
    }
    return values
}

/** Entity each row cache is stored as. A slot row is stored whole in jsonb. */
export const ROW_ENTITIES: Record<string, Function | "jsonb"> = {
    accounts: GCRMain,
    storagePrograms: GCRStorageProgram,
    tlsNotaries: GCRTLSNotary,
    atomicWorks: GCRAtomicWork,
    resourceSlots: "jsonb",
    validators: Validators,
    networkUpgrades: NetworkUpgrade,
    networkUpgradeVotes: NetworkUpgradeVote,
}

/**
 * Where `row` of `cache` cannot be stored, as "cache.column", or null.
 * `stored` is what `indexedValues` read from the row before the edit.
 */
export function unstorableRow(cache: string, row: unknown, stored?: IndexedValues): string | null {
    const entity = ROW_ENTITIES[cache]
    if (entity === undefined || row === null || row === undefined) return null
    if (entity === "jsonb") return isJsonbStorable(row) ? null : cache
    const column = unstorableColumn(entity, row, stored)
    return column === null ? null : `${cache}.${column}`
}

/**
 * Claims (ZK commitments, nullifiers) are stored by their key, in a text
 * primary key column.
 */
export function unstorableClaim(cache: string, claims: Map<string, unknown> | undefined): string | null {
    if (!claims) return null
    for (const key of claims.keys()) {
        if (!isTextStorable(key) || !fitsIndexKey(key)) return cache
    }
    return null
}

type EditView = {
    type?: unknown
    operation?: unknown
    account?: unknown
    target?: unknown
    workId?: unknown
    resourceKey?: unknown
    data?: unknown
}

/**
 * Byte caps for the keys edits name rows by, each a text primary key. Set
 * above the longest key the node or SDK derives, and far below what a b-tree
 * entry holds: a storage address is "stor-" and 40 hex digits, a tlsnotary
 * token "tlsn_" and a UUID, a Work id 64 hex digits. A resource key is
 * derived by the Work's profile, so it gets more room.
 */
export const EDIT_KEY_MAX_BYTES = {
    storageAddress: 64,
    tokenId: 64,
    workId: 128,
    resourceKey: 256,
} as const

const ACCOUNT_EDITS = new Set(["balance", "nonce", "identity"])
const TARGET_EDITS = new Set(["storageProgram", "storage-program-put"])
const WORK_EDITS = new Set(["work-attempt", "work-receipt"])

/**
 * Why a transaction's edits cannot have their rows loaded, as "where: why",
 * or null. Loading reads the rows by keys taken from the edits, before any
 * edit applies and outside the per-edit failure handling, so a key that
 * throws there (Postgres refusing it, or an account the node cannot load or
 * create) fails the whole block on every node. Refused here, the transaction
 * fails alone. Mirrors HandleGCR.prepareEntities, key by key; `accountProblem`
 * judges an account key, `loaded` false for one that is only grouped by.
 *
 * Text keys must also be free of unpaired surrogates: Postgres stores one as
 * U+FFFD, so two keys that differ in memory would share a row.
 */
export function unloadableEditKey(
    tx: unknown,
    accountProblem: (account: unknown, loaded: boolean) => string | null,
): string | null {
    const content = (tx as { content?: { gcr_edits?: unknown; from_ed25519_address?: unknown } })?.content
    const edits: unknown[] = Array.isArray(content?.gcr_edits) ? content.gcr_edits : []
    for (const [i, item] of edits.entries()) {
        if (typeof item !== "object" || item === null) return `gcr_edits[${i}]: not an edit`
        const refusal = editKeyRefusal(item as EditView, `gcr_edits[${i}] ${String((item as EditView).type)}`, accountProblem)
        if (refusal !== null) return refusal
    }
    const sender = content?.from_ed25519_address
    return sender ? accountRefusal("from_ed25519_address", sender, true, accountProblem) : null
}

function accountRefusal(
    where: string,
    value: unknown,
    loaded: boolean,
    accountProblem: (account: unknown, loaded: boolean) => string | null,
): string | null {
    const problem = accountProblem(value, loaded)
    return problem === null ? null : `${where}: ${problem}`
}

function textKeyRefusal(where: string, value: unknown, maxBytes: number): string | null {
    if (typeof value !== "string") return `${where}: not a string`
    if (!isKeyStorable(value)) return `${where}: ${NOT_STORABLE}`
    if (!fitsIndexKey(value, maxBytes)) return `${where}: longer than ${maxBytes} bytes`
    return null
}

/** Why one edit's row keys cannot be loaded, mirroring prepareEntities. */
function editKeyRefusal(
    edit: EditView,
    where: string,
    accountProblem: (account: unknown, loaded: boolean) => string | null,
): string | null {
    const type = String(edit.type)
    // Grouping the block's transactions reads it as a string.
    if (type === "identity" && edit.operation != null && typeof edit.operation !== "string") {
        return `${where}: operation is not a string`
    }
    if (ACCOUNT_EDITS.has(type)) return accountRefusal(`${where} account`, edit.account, true, accountProblem)
    if (TARGET_EDITS.has(type)) return textKeyRefusal(`${where} target`, edit.target, EDIT_KEY_MAX_BYTES.storageAddress)
    if (WORK_EDITS.has(type)) return textKeyRefusal(`${where} workId`, edit.workId, EDIT_KEY_MAX_BYTES.workId)
    if (type === "resource-slot-cas") {
        return textKeyRefusal(`${where} resourceKey`, edit.resourceKey, EDIT_KEY_MAX_BYTES.resourceKey)
    }
    if (type !== "tlsnotary") return null
    if (typeof edit.data !== "object" || edit.data === null) return `${where}: no data`
    const tokenId = (edit.data as { tokenId?: unknown }).tokenId
    return (
        textKeyRefusal(`${where} tokenId`, tokenId, EDIT_KEY_MAX_BYTES.tokenId) ??
        (edit.account ? accountRefusal(`${where} account`, edit.account, false, accountProblem) : null)
    )
}
