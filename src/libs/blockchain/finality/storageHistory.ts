/**
 * Undo log of `gcr_storageprogram` over the last STORAGE_HISTORY_BLOCKS
 * blocks, kept in `storage_program_history`.
 *
 * Block B commits the storage root of the state after B - 1, while the
 * table always holds the state after the head T. For every program block N
 * changed, the log keeps its record from before N (null when N created it),
 * so the leaf set B committed is the table with the rows of blocks B..T
 * undone, newest first. Rows are written in the block's own insert
 * transaction, before the block's storage writes, and roll back with it.
 *
 * Local bookkeeping only: nothing here enters a block, a hash or consensus,
 * and a node that lacks a row answers a proof with an error, never a
 * different root.
 */

import {
    Between,
    In,
    LessThan,
    MoreThan,
    MoreThanOrEqual,
    type EntityManager,
} from "typeorm"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { StorageProgramHistory } from "@/model/entities/StorageProgramHistory"
import { storageProgramRecord, type StorageProgramRecord } from "./storageRecord"

/** Blocks whose committed storage root a proof can still be served against. */
export const STORAGE_HISTORY_BLOCKS = 64

const ROW_BATCH = 200

export interface StorageHistoryRow {
    block: number
    storageAddress: string
    record: StorageProgramRecord | null
}

/** The oldest block a storage proof can anchor at while `tip` is the head. */
export function oldestProvableBlock(tip: number): number {
    return Math.max(1, tip - STORAGE_HISTORY_BLOCKS + 1)
}

/**
 * Logs the record each of `addresses` has before `block` changes it. Must
 * run inside the block's transaction before its storage rows are written.
 * Only the first touch of an address in a block is kept: a later one would
 * log a state from inside the block, which no block committed.
 */
export async function recordStorageHistory(
    em: EntityManager,
    block: number,
    addresses: string[],
): Promise<void> {
    const programs = em.getRepository(GCRStorageProgram)
    const history = em.getRepository(StorageProgramHistory)
    for (let i = 0; i < addresses.length; i += ROW_BATCH) {
        const batch = addresses.slice(i, i + ROW_BATCH)
        const rows = await programs.find({ where: { storageAddress: In(batch) } })
        const before = new Map(rows.map(row => [row.storageAddress, row]))
        const entries = batch.map(storageAddress => {
            const row = before.get(storageAddress)
            return {
                block,
                storageAddress,
                record: row ? storageProgramRecord(row) : null,
            }
        })
        await history.createQueryBuilder().insert().values(entries).orIgnore().execute()
    }
}

/**
 * Called in the insert transaction of `block`, before its state is written:
 * rows at or above it were logged for a branch this node no longer follows,
 * and rows below the window are no longer needed.
 */
export async function resetStorageHistory(
    em: EntityManager,
    block: number,
): Promise<void> {
    const history = em.getRepository(StorageProgramHistory)
    await history.delete({ block: MoreThanOrEqual(block) })
    const oldest = oldestProvableBlock(block)
    if (oldest > 1) await history.delete({ block: LessThan(oldest) })
}

/** Rows of blocks `from`..`to`, newest block first. */
export async function readStorageHistory(
    em: EntityManager,
    from: number,
    to: number,
): Promise<StorageHistoryRow[]> {
    if (to < from) return []
    const rows = await em.getRepository(StorageProgramHistory).find({
        where: { block: Between(from, to) },
        order: { block: "DESC", storageAddress: "ASC" },
    })
    return rows.map(row => ({
        block: Number(row.block),
        storageAddress: row.storageAddress,
        record: row.record ?? null,
    }))
}

/** Drops every row above `height`, with the blocks they were logged for. */
export async function pruneStorageHistory(height: number): Promise<void> {
    const { default: datasource } = await import("src/model/datasource")
    await (await datasource.getInstance())
        .getDataSource()
        .getRepository(StorageProgramHistory)
        .delete({ block: MoreThan(height) })
}
