/**
 * State-snapshot restore orchestrator (P1-T2 + P1-T3).
 *
 * Consumes the async iterables exposed by `loadSnapshot.ts` and bulk-
 * inserts the rows into `gcr_main`, `gcr_storageprogram`, and
 * `identity_commitments`. The whole restore MUST run inside a single
 * caller-owned TypeORM transaction so partial failure rolls back
 * cleanly.
 *
 * Pre-flight refuses to run against a non-empty database — operators
 * must wipe with `./run -b true` (or remove the `data_*` PG volume) and
 * then re-boot.
 *
 * NOTE: this module never touches block-0 hashing. Block-0 carries
 * `genesisData` (whatever is in `data/genesis.json`) into its `extra`
 * field; the snapshot data is restored as a separate side-effect within
 * the same atomic transaction. Operators changing `data/genesis.json`
 * intentionally change block-0 hash; restoring snapshot rows does not.
 */

import { verifySeededNfts } from "src/features/staking/seedNft"
import type { EntityManager } from "typeorm"

import log from "src/utilities/logger"
import { compareCodeUnits } from "src/libs/crypto/canonicalJson"
import { maxRowsPerInsert } from "src/libs/blockchain/chainDb"
import { GCRMain } from "src/model/entities/GCRv2/GCR_Main"
import { GCRAssignedTx } from "src/model/entities/GCRv2/GCRAssignedTx"
import { GCRStorageProgram } from "src/model/entities/GCRv2/GCR_StorageProgram"
import { IdentityCommitment } from "src/model/entities/GCRv2/IdentityCommitment"
import { Validators } from "src/model/entities/Validators"
import { GenesisImportedIdentity } from "src/model/entities/GenesisImportedIdentity"
import {
    assertCarryoverRow,
    importedIdentityKeys,
} from "src/libs/blockchain/genesis/carryover"

import type {
    SnapshotLoaderAvailable,
    GCRMainSeed,
    GCRStorageProgramSeed,
    IdentityCommitmentSeed,
    ValidatorSeed,
} from "src/libs/blockchain/genesis/loadSnapshot"

// Batch sizes chosen by data-shape. gcr_main rows are skinny; storage
// and identity rows carry jsonb data blobs so we keep the batch smaller
// to avoid oversized single statements.
const GCR_MAIN_BATCH = 500
const STORAGE_BATCH = 100
const IDENTITY_BATCH = 100
const VALIDATORS_BATCH = 200

/**
 * Pre-flight check: every target table must be empty AND the chain must
 * not have inserted block 0 yet. Throws with operator-facing guidance
 * on any non-empty table.
 *
 * Called from inside the same transaction the bulk inserts will use, so
 * the row counts we read are the same ones the inserts will see.
 */
async function preflightEmpty(
    em: EntityManager,
    carryover: boolean,
): Promise<void> {
    const checks: Array<{ table: string; count: number }> = []
    for (const table of [
        "gcr_main",
        "gcr_assigned_txs",
        "gcr_storageprogram",
        "identity_commitments",
        "blocks",
        "validators",
        ...(carryover ? ["genesis_imported_identities"] : []),
    ]) {
        // Use raw SQL: cheaper than spinning up the repository abstraction
        // for a simple count and works uniformly across entities whose
        // repositories may or may not be cached on this em.
        const rows: Array<{ count: string }> = await em.query(
            `SELECT COUNT(*)::text AS count FROM ${table}`,
        )
        const count = Number(rows[0]?.count ?? "0")
        if (!Number.isSafeInteger(count)) {
            throw new Error(
                `[GENESIS][SNAPSHOT] preflight: failed to count rows in ${table}`,
            )
        }
        checks.push({ table, count })
    }

    const offenders = checks.filter(c => c.count > 0)
    if (offenders.length > 0) {
        const detail = offenders
            .map(o => `${o.table}=${o.count}`)
            .join(", ")

        // Distinguish between two failure modes so operators know which
        // recovery path to take:
        //
        // (A) Partial genesis — gcr_main is populated but blocks is empty.
        //     This can occur if a previous boot's restoreSnapshot transaction
        //     committed but the subsequent insertBlock (which runs outside
        //     the snapshot transaction) crashed before completing. The DB
        //     contains snapshot rows but no block 0.
        //     Recovery: wipe and restart — `./run -b true` or remove the
        //     data_* PG volume. Do NOT attempt to re-run without wiping.
        //
        // (B) Fully initialised chain — both gcr_main and blocks are
        //     populated. This is the normal "node already started" case.
        //     Recovery: no action needed; genesis is complete.
        //
        // Both cases use the same throw path (the caller's outer transaction
        // rolls back), but the message helps operators diagnose without
        // inspecting the DB manually.
        const gcrMainCount = checks.find(c => c.table === "gcr_main")?.count ?? 0
        const blocksCount = checks.find(c => c.table === "blocks")?.count ?? 0
        const isPartialGenesis = gcrMainCount > 0 && blocksCount === 0

        if (isPartialGenesis) {
            throw new Error(
                `[GENESIS][SNAPSHOT] partial genesis detected: gcr_main has ${gcrMainCount} row(s) but blocks is empty. ` +
                    "A previous boot's snapshot restore committed but block-0 insertion did not complete. " +
                    "Wipe with './run -b true' or remove data_* folders, then retry.",
            )
        }

        throw new Error(
            "[GENESIS][SNAPSHOT] snapshot restore requires empty database; " +
                `found rows in: ${detail}. ` +
                "If the chain is already initialised, no action is needed. " +
                "To wipe and re-restore, use './run -b true' or remove data_* folders, then retry.",
        )
    }
}

/**
 * Inserts an async-iterable stream of rows in fixed-size batches via
 * `em.insert(...)`. Yields a per-batch progress callback so the orchestrator
 * can log against expected totals from the manifest.
 */
async function bulkInsertStream<T extends object>(
    em: EntityManager,
    target: { new (): T },
    stream: AsyncIterable<T>,
    batchSize: number,
    onBatch: (inserted: number) => void,
): Promise<number> {
    let inserted = 0
    let batch: T[] = []
    for await (const row of stream) {
        batch.push(row)
        if (batch.length >= batchSize) {
            await em.insert(target, batch)
            inserted += batch.length
            onBatch(inserted)
            batch = []
        }
    }
    if (batch.length > 0) {
        await em.insert(target, batch)
        inserted += batch.length
        onBatch(inserted)
    }
    return inserted
}

/**
 * Insert gcr_main rows, routing the legacy per-account `assignedTxs` array
 * into the dedicated `gcr_assigned_txs` relation.
 *
 * The snapshot JSONL predates `MoveAssignedTxsToOwnTable` (dumped from a
 * node version where `assignedTxs` was a jsonb column on `gcr_main`). The
 * current `GCRMain` entity has no such column, so inserting the seed
 * verbatim raises `column "assignedTxs" of relation "gcr_main" does not
 * exist`. We strip the field from the gcr_main insert and re-materialise
 * each tx-hash assignment as a `(pubkey, tx_hash, block_number)` row in
 * `gcr_assigned_txs` — matching `HandleGCR.bulkUpdateAssignedTxs`.
 *
 * `block_number` is not present in the legacy array (it stored bare
 * hashes), so it falls back to the entity default (0). This is the
 * snapshot-baseline convention: the snapshot is a single point-in-time
 * state, not a per-block history.
 *
 * Both inserts run on the caller's transactional EntityManager, so a
 * failure in either rolls the whole restore back.
 */
async function insertGcrMainStream(
    em: EntityManager,
    stream: AsyncIterable<GCRMainSeed>,
    batchSize: number,
    onBatch: (inserted: number) => void,
    carryover: boolean,
): Promise<{ inserted: number; importedIdentities: number }> {
    type AssignedRow = { pubkey: string; txHash: string }
    let inserted = 0
    let mainBatch: Omit<GCRMainSeed, "assignedTxs">[] = []
    let assignedBatch: AssignedRow[] = []
    // One identity linked to several accounts yields one key; the set keeps
    // the inserts free of duplicates within this restore.
    const identityKeys = new Set<string>()

    // gcr_main: TypeORM maps only entity columns, so the seed minus
    // assignedTxs is the exact column set. Cast mirrors the existing
    // bulkInsertStream pattern (seed carries pre-bigint balance shape).
    const flushMain = async () => {
        if (mainBatch.length === 0) return
        await em.insert(
            GCRMain as unknown as { new (): Omit<GCRMainSeed, "assignedTxs"> },
            mainBatch,
        )
        inserted += mainBatch.length
        onBatch(inserted)
        mainBatch = []
    }

    const assignedChunkSize = maxRowsPerInsert(em, GCRAssignedTx)
    const flushAssigned = async (force: boolean) => {
        while (
            assignedBatch.length >= assignedChunkSize ||
            (force && assignedBatch.length > 0)
        ) {
            const chunk = assignedBatch.slice(0, assignedChunkSize)
            assignedBatch = assignedBatch.slice(assignedChunkSize)
            await em
                .createQueryBuilder()
                .insert()
                .into(GCRAssignedTx)
                .values(chunk)
                .orIgnore()
                .execute()
        }
    }

    let rowNo = 0
    for await (const row of stream) {
        rowNo++
        if (carryover) {
            assertCarryoverRow(row, rowNo)
            for (const key of importedIdentityKeys(row.identities)) {
                identityKeys.add(key)
            }
        }
        const { assignedTxs, ...mainRow } = row
        mainBatch.push(mainRow)
        for (const txHash of assignedTxs) {
            assignedBatch.push({ pubkey: row.pubkey, txHash })
        }
        if (mainBatch.length >= batchSize) await flushMain()
        await flushAssigned(false)
    }
    await flushMain()
    await flushAssigned(true)

    if (carryover && identityKeys.size > 0) {
        const rows = [...identityKeys].sort(compareCodeUnits).map(identityKey => ({ identityKey }))
        const chunkSize = maxRowsPerInsert(em, GenesisImportedIdentity)
        for (let i = 0; i < rows.length; i += chunkSize) {
            await em
                .createQueryBuilder()
                .insert()
                .into(GenesisImportedIdentity)
                .values(rows.slice(i, i + chunkSize))
                .execute()
        }
    }
    return { inserted, importedIdentities: identityKeys.size }
}

/**
 * Restore the snapshot tables under the caller-owned transaction.
 *
 * The caller MUST have already verified that `loader.available === true`.
 * On any error this function throws and the outer transaction must roll
 * back. Block-0 is not part of this function's contract — callers wrap
 * `restoreSnapshot` + the block-0 insert in a single transaction in
 * `chainGenesis.ts`.
 *
 * @param em      Caller-owned transactional EntityManager.
 * @param loader  Verified, available snapshot loader.
 */
export type RestoreReport = {
    gcrMain: number
    gcrStorageProgram: number
    identityCommitments: number
    validators: number
    /** Distinct identities recorded as carried over; 0 without carryover. */
    importedIdentities: number
    elapsed_ms: number
}

export type RestoreOptions = {
    /**
     * identityCarryover at genesis: refuse any row with a balance and record
     * every imported identity in genesis_imported_identities.
     */
    carryover?: boolean
}

export async function restoreSnapshot(
    em: EntityManager,
    loader: SnapshotLoaderAvailable,
    options: RestoreOptions = {},
): Promise<RestoreReport> {
    const carryover = options.carryover === true
    const t0 = Date.now()
    const manifest = loader.getSnapshotManifest()
    const expectedGcrMain = manifest.files["gcr_main.jsonl"].rows
    const expectedStorage = manifest.files["gcr_storageprogram.jsonl"].rows
    const expectedIdentity = manifest.files["identity_commitments.jsonl"].rows

    log.info(
        `[GENESIS][SNAPSHOT] snapshot present: block=${manifest.source.chain_block_height} hash=${manifest.source.chain_block_hash.slice(0, 16)}`,
    )

    await preflightEmpty(em, carryover)

    // gcr_main rows carry a legacy `assignedTxs` array (pre-MoveAssignedTxsToOwnTable
    // snapshot). insertGcrMainStream strips it from the gcr_main insert and
    // routes the assignments into gcr_assigned_txs within this same transaction.
    const { inserted: gcrMainInserted, importedIdentities } =
        await insertGcrMainStream(
            em,
            loader.streamGcrMain(),
            GCR_MAIN_BATCH,
            n => {
                log.info(
                    `[GENESIS][SNAPSHOT] gcr_main: inserted ${n}/${expectedGcrMain}`,
                )
            },
            carryover,
        )
    if (gcrMainInserted !== expectedGcrMain) {
        throw new Error(
            `[GENESIS][SNAPSHOT] gcr_main row mismatch: inserted ${gcrMainInserted}, manifest expects ${expectedGcrMain}`,
        )
    }

    const storageInserted = await bulkInsertStream<GCRStorageProgramSeed>(
        em,
        GCRStorageProgram as unknown as { new (): GCRStorageProgramSeed },
        loader.streamGcrStorageProgram(),
        STORAGE_BATCH,
        n => {
            log.info(
                `[GENESIS][SNAPSHOT] gcr_storageprogram: inserted ${n}/${expectedStorage}`,
            )
        },
    )
    if (storageInserted !== expectedStorage) {
        throw new Error(
            `[GENESIS][SNAPSHOT] gcr_storageprogram row mismatch: inserted ${storageInserted}, manifest expects ${expectedStorage}`,
        )
    }

    // identity_commitments is currently a zero-row file (the single test
    // row was dropped in transform). bulkInsertStream handles that
    // cleanly — no batches will be flushed. We still emit a final-count
    // log line so operators see all three tables accounted for.
    const identityInserted = await bulkInsertStream<IdentityCommitmentSeed>(
        em,
        IdentityCommitment as unknown as { new (): IdentityCommitmentSeed },
        loader.streamIdentityCommitments(),
        IDENTITY_BATCH,
        n => {
            log.info(
                `[GENESIS][SNAPSHOT] identity_commitments: inserted ${n}/${expectedIdentity}`,
            )
        },
    )
    if (identityInserted !== expectedIdentity) {
        throw new Error(
            `[GENESIS][SNAPSHOT] identity_commitments row mismatch: inserted ${identityInserted}, manifest expects ${expectedIdentity}`,
        )
    }
    if (identityInserted === 0) {
        // bulkInsertStream skipped the per-batch log because there were
        // no batches; emit the final line explicitly for symmetry.
        log.info(
            `[GENESIS][SNAPSHOT] identity_commitments: inserted 0/${expectedIdentity}`,
        )
    }

    // validators: only present in schemaVersion 2 snapshots. When the manifest
    // carries a validators.jsonl entry, the snapshot owns the validator set
    // (chainGenesis skips the genesis.json seeding path in that case). The
    // staked amounts ride the same pre/post-OS contract as balances: if the
    // snapshot is pre-fork, applyForksAtGenesis multiplies them ×1e9.
    const validatorsEntry = manifest.files["validators.jsonl"]
    let validatorsInserted = 0
    if (validatorsEntry) {
        const expectedValidators = validatorsEntry.rows
        validatorsInserted = await bulkInsertStream<ValidatorSeed>(
            em,
            Validators as unknown as { new (): ValidatorSeed },
            nftCheckedValidators(loader.streamValidators()),
            VALIDATORS_BATCH,
            n => {
                log.info(
                    `[GENESIS][SNAPSHOT] validators: inserted ${n}/${expectedValidators}`,
                )
            },
        )
        if (validatorsInserted !== expectedValidators) {
            throw new Error(
                `[GENESIS][SNAPSHOT] validators row mismatch: inserted ${validatorsInserted}, manifest expects ${expectedValidators}`,
            )
        }
        if (validatorsInserted === 0) {
            log.info(
                `[GENESIS][SNAPSHOT] validators: inserted 0/${expectedValidators}`,
            )
        }
    }

    const elapsed_ms = Date.now() - t0
    log.info(
        `[GENESIS][SNAPSHOT] restore complete: gcr_main=${gcrMainInserted}, gcr_storageprogram=${storageInserted}, identity_commitments=${identityInserted}, validators=${validatorsInserted}` +
            (carryover ? `, imported_identities=${importedIdentities}` : "") +
            ` elapsed=${elapsed_ms}ms`,
    )

    return {
        gcrMain: gcrMainInserted,
        gcrStorageProgram: storageInserted,
        identityCommitments: identityInserted,
        validators: validatorsInserted,
        importedIdentities,
        elapsed_ms,
    }
}

/**
 * Pass validator rows through to the insert and, once the file is read,
 * refuse the restore when the set breaks the NFT rules. The insert runs in
 * the genesis transaction, so the throw rolls every row back.
 */
async function* nftCheckedValidators(
    rows: AsyncIterable<ValidatorSeed>,
): AsyncIterable<ValidatorSeed> {
    const seen: ValidatorSeed[] = []
    for await (const row of rows) {
        seen.push(row)
        yield row
    }
    const reasons = await verifySeededNfts(seen, "validators.jsonl")
    if (reasons.length > 0) {
        throw new Error(`[GENESIS][SNAPSHOT] ${reasons.join("; ")}`)
    }
}
