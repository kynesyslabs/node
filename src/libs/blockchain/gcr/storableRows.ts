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

type ColumnKind = "text" | "jsonb" | "other"

const TEXT_TYPES = new Set(["text", "varchar", "character varying", "char", "character", "citext", "uuid", "enum"])

const kindsByEntity = new Map<Function, Map<string, ColumnKind>>()

function columnKinds(entity: Function): Map<string, ColumnKind> {
    let kinds = kindsByEntity.get(entity)
    if (kinds) return kinds
    kinds = new Map()
    for (const column of getMetadataArgsStorage().columns) {
        if (column.target !== entity) continue
        const type = column.options.type
        const name = typeof type === "string" ? type.toLowerCase() : type === String ? "varchar" : ""
        kinds.set(
            column.propertyName,
            name === "jsonb" ? "jsonb" : TEXT_TYPES.has(name) ? "text" : "other",
        )
    }
    kindsByEntity.set(entity, kinds)
    return kinds
}

/** The first column of `row`, stored as `entity`, that Postgres would refuse. */
export function unstorableColumn(entity: Function, row: unknown): string | null {
    if (typeof row !== "object" || row === null) return null
    for (const [property, kind] of columnKinds(entity)) {
        const value = (row as Record<string, unknown>)[property]
        if (kind === "text" && !isTextStorable(value)) return property
        if (kind === "jsonb" && !isJsonbStorable(value)) return property
    }
    return null
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

/** Where `row` of `cache` cannot be stored, as "cache.column", or null. */
export function unstorableRow(cache: string, row: unknown): string | null {
    const entity = ROW_ENTITIES[cache]
    if (entity === undefined || row === null || row === undefined) return null
    if (entity === "jsonb") return isJsonbStorable(row) ? null : cache
    const column = unstorableColumn(entity, row)
    return column === null ? null : `${cache}.${column}`
}

/**
 * Claims (ZK commitments, nullifiers) are stored by their key, in a text
 * column.
 */
export function unstorableClaim(cache: string, claims: Map<string, unknown> | undefined): string | null {
    if (!claims) return null
    for (const key of claims.keys()) {
        if (!isTextStorable(key)) return cache
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
    const account = (where: string, value: unknown, loaded = true) => {
        const problem = accountProblem(value, loaded)
        return problem === null ? null : `${where}: ${problem}`
    }
    const text = (where: string, value: unknown) =>
        isKeyStorable(value) ? null : `${where}: ${NOT_STORABLE}`

    for (const [i, item] of edits.entries()) {
        if (typeof item !== "object" || item === null) return `gcr_edits[${i}]: not an edit`
        const edit = item as EditView
        const type = String(edit.type)
        const where = `gcr_edits[${i}] ${type}`
        // Grouping the block's transactions reads it as a string.
        if (type === "identity" && edit.operation != null && typeof edit.operation !== "string") {
            return `${where}: operation is not a string`
        }
        const refusal = ACCOUNT_EDITS.has(type)
            ? account(`${where} account`, edit.account)
            : TARGET_EDITS.has(type)
              ? text(`${where} target`, edit.target)
              : type === "tlsnotary"
                ? typeof edit.data === "object" && edit.data !== null
                    ? text(`${where} tokenId`, (edit.data as { tokenId?: unknown }).tokenId) ??
                      (edit.account ? account(`${where} account`, edit.account, false) : null)
                    : `${where}: no data`
                : WORK_EDITS.has(type)
                  ? text(`${where} workId`, edit.workId)
                  : type === "resource-slot-cas"
                    ? text(`${where} resourceKey`, edit.resourceKey)
                    : null
        if (refusal !== null) return refusal
    }
    const sender = content?.from_ed25519_address
    return sender ? account("from_ed25519_address", sender) : null
}
