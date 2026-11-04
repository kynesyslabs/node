import { getMetadataArgsStorage } from "typeorm"

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { GCRAtomicWork } from "@/model/entities/GCRv2/GCR_AtomicWork"
import { Validators } from "@/model/entities/Validators"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import {
    isJsonbStorable,
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
