/**
 * The record each storage program contributes to the storage state root
 * (`native_tables_hashes.native_storage_programs`). A client that checks a
 * storage proof rebuilds it from what the node serves, so this definition is
 * part of the protocol and changes only with a fork:
 *
 *   record = {
 *       storageAddress:   string
 *       owner:            string
 *       programName:      string
 *       encoding:         "json" | "binary"
 *       dataHash:         sha256hex(utf8(canonicalJson(data)))
 *       sizeBytes:        number
 *       aclHash:          sha256hex(utf8(canonicalJson(acl)))
 *       metadataHash:     sha256hex(utf8(canonicalJson(metadata)))
 *       createdByTx:      string
 *       lastModifiedByTx: string
 *       isDeleted:        boolean
 *   }
 *   key       = sha256(utf8(storageAddress))
 *   valueHash = sha256(0x00 || utf8(canonicalJson(record)))
 *
 * `canonicalJson` is src/libs/crypto/canonicalJson.ts (sorted keys, no
 * Unicode normalization), not JCS. Hashes are lowercase hex without `0x`.
 *
 * - `data`, `acl` and `metadata` are hashed as the database returns them: a
 *   missing value is `null` (hashed as the text `null`), and every value goes
 *   through a JSON round trip first, because that is what the jsonb column
 *   keeps. A leaf computed from a row being written must equal the leaf a
 *   node computes later from the stored row.
 * - Binary programs hash their stored base64 string as a JSON string, the
 *   same rule as JSON programs. Hashing decoded bytes would let two stored
 *   spellings of one byte string share a leaf while the node serves different
 *   text for them.
 * - Text columns are taken as Postgres stores them: UTF-8, so a lone surrogate
 *   in memory reads back as U+FFFD.
 * - Left out: columns that are node-local (createdAt, updatedAt), stubs or
 *   history (storageLocation, ipfsCid, salt, interactionTxs, deletedByTx) and
 *   fee accounting (totalFeesPaid). They say nothing a reader of the program
 *   relies on, and leaving them out keeps the leaf stable across nodes.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import { canonicalJson } from "@/libs/crypto/canonicalJson"
import { toHex } from "@/libs/crypto/merkle/hex"

/** The columns of a storage program row the record is built from. */
export interface StorageProgramRow {
    storageAddress: string
    owner: string
    programName: string
    encoding: string
    data?: unknown
    sizeBytes: number
    acl?: unknown
    metadata?: unknown
    createdByTx: string
    lastModifiedByTx: string
    isDeleted?: boolean | null
}

export interface StorageProgramRecord {
    storageAddress: string
    owner: string
    programName: string
    encoding: string
    dataHash: string
    sizeBytes: number
    aclHash: string
    metadataHash: string
    createdByTx: string
    lastModifiedByTx: string
    isDeleted: boolean
}

const LEAF_VALUE_PREFIX = Uint8Array.of(0x00)
const utf8 = new TextEncoder()

const sha256Hex = (text: string): string => toHex(sha256(utf8.encode(text)))

function asStored(text: string): string {
    return Buffer.from(String(text), "utf8").toString("utf8")
}

function jsonbValue(value: unknown): unknown {
    if (value === undefined || value === null) return null
    const text = JSON.stringify(value)
    return text === undefined ? null : JSON.parse(text)
}

const jsonHash = (value: unknown): string => sha256Hex(canonicalJson(jsonbValue(value)))

export function storageProgramRecord(row: StorageProgramRow): StorageProgramRecord {
    return {
        storageAddress: asStored(row.storageAddress),
        owner: asStored(row.owner),
        programName: asStored(row.programName),
        encoding: asStored(row.encoding),
        dataHash: jsonHash(row.data),
        sizeBytes: Number(row.sizeBytes),
        aclHash: jsonHash(row.acl),
        metadataHash: jsonHash(row.metadata),
        createdByTx: asStored(row.createdByTx),
        lastModifiedByTx: asStored(row.lastModifiedByTx),
        isDeleted: row.isDeleted === true,
    }
}

/** Value hash of the program's leaf, as stored in `smtLeaf`. */
export function storageProgramLeafHex(row: StorageProgramRow): string {
    return storageRecordLeafHex(storageProgramRecord(row))
}

/** Value hash of a record as served in a storage proof. */
export function storageRecordLeafHex(record: StorageProgramRecord): string {
    const text = canonicalJson(record)
    return toHex(sha256.create().update(LEAF_VALUE_PREFIX).update(utf8.encode(text)).digest())
}

/** Position of the program in the sparse tree. */
export function storageProgramKey(storageAddress: string): Uint8Array {
    return sha256(utf8.encode(asStored(storageAddress)))
}
