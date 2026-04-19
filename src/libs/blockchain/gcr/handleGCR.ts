// ! Unify this and gcr.ts methods
/** TODO
 * 1. Port here the following methods from gcr.ts:
 *      - assignXM
 *      - assignWeb2
 * 2. Ensure no file calls gcr.ts methods and if so, port them here
 * 3. Add methods for the following:
 *      - update of balance, nonce, txs
 *      - update for tokens, nfts, xm, web2, other
 *      - a parser for GCR updates that calls the above methods
 *      - Use txToOperations to convert transactions to operations
 * 4. Ensure GCRJsonbHandler is used for all JSONB operations
 * 5. Ensure GCRTracker is updated for all operations pertaining to an address
 */

/** NOTE
 * To implement the assign calls, see txToGCR.drawio.png schema to have an idea of how to
 * convert a demosWork in a GCROperation and how to change the GCR with that operation.
 * - Also implement the new GCROperation structure replacing the old Operation one
 */

import { emptyResponse } from "./../../network/server_rpc"
import _ from "lodash"
// NOTE This will replace gcr.ts methods for calling the native tables
import { GCRSubnetsTxs } from "src/model/entities/GCRv2/GCRSubnetsTxs" // TODO Put this in the sdk when done
import { GCRHashes } from "src/model/entities/GCRv2/GCRHashes"
import { RPCResponse, Transaction } from "@kynesyslabs/demosdk/types"
import Datasource, { dataSource } from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import hashGCRTables from "./gcr_routines/hashGCR"
import * as GCRJsonbHandler from "./gcr_routines/gcrJSONBHandler"
import ensureGCRForUser from "./gcr_routines/ensureGCRForUser"
import gcrStateSave from "./gcr_routines/gcrStateSaverHelper"
import { assignXM } from "./gcr_routines/assignXM"
import { assignWeb2 } from "./gcr_routines/assignWeb2"
import IdentityManager from "./gcr_routines/identityManager"
import manageNative from "./gcr_routines/manageNative"
import { GCREdit, GCREditStorageProgram } from "@kynesyslabs/demosdk/types"
import { GCREditTLSNotary } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"
import log from "src/utilities/logger"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

// REVIEW Trying to use the new GCRv2
import { GCRMain } from "src/model/entities/GCRv2/GCR_Main"
import { GCRTracker } from "src/model/entities/GCR/GCRTracker"
import GCRBalanceRoutines from "./gcr_routines/GCRBalanceRoutines"
import GCRNonceRoutines from "./gcr_routines/GCRNonceRoutines"

import Chain from "../chain"
import { In, Repository } from "typeorm"
import { Mutex } from "async-mutex"
import GCRIdentityRoutines from "./gcr_routines/GCRIdentityRoutines"
import { GCRTLSNotaryRoutines } from "./gcr_routines/GCRTLSNotaryRoutines"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { GCRStorageProgramRoutines } from "./gcr_routines/GCRStorageProgramRoutines"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { Referrals } from "@/features/incentive/referrals"
// REVIEW: TLSNotary token management for native operations
import { createToken, extractDomain } from "@/features/tlsnotary/tokenManager"
import { INativePayload } from "@kynesyslabs/demosdk/types"

export type GetNativeStatusOptions = {
    balance?: boolean
    nonce?: boolean
    txList?: boolean
    identities?: boolean
    extended?: boolean
}

export type GetNativePropertiesOptions = {
    tokens?: boolean
    nfts?: boolean
    xm?: boolean
    web2?: boolean
    other?: boolean
}

export type GetNativeSubnetsTxsOptions = {
    txData?: boolean
}

export interface GCRResult {
    success: boolean
    message: string
    entity?: GCRMain
    storageProgram?: GCRStorageProgram
    tlsNotary?: GCRTLSNotary
    sideEffect?: () => Promise<void>
    response?: any
}

export interface GCRTLSNotaryResult extends GCRResult {
    tlsNotary: GCRTLSNotary | null
}

export interface GCREntityCaches {
    accounts: Map<string, GCRMain>
    storagePrograms: Map<string, GCRStorageProgram | null>
    tlsNotaries: Map<string, GCRTLSNotary | null>
}

export interface GCRApplyResult {
    success: boolean
    entities: GCREntityCaches
    message: string
    sideEffects: (() => Promise<void>)[]
    appliedEditsCount: number
}

/**
 * Type for GCREdit that has an account property (balance, nonce types)
 */
type GCREditWithAccount = GCREdit & {
    account: string | Uint8Array
}

/**
 * Type guard to check if a GCREdit targets GCRMain (can be batch processed)
 * Returns true for balance and nonce types which have the 'account' property
 */
export function isBatchableGCREdit(edit: GCREdit): edit is GCREditWithAccount {
    // @ts-expect-error - edit.account is not available in GCREditStorageProgram type
    return edit.account !== undefined && edit.account !== null
}

/**
 * Helper to normalize pubkey from different formats
 */
function normalizePubkey(account: string | Uint8Array): string {
    return typeof account === "string" ? account : forgeToHex(account)
}

/**
 * Interface for tracking entity snapshots for rollback
 */
interface GCRMainSnapshot {
    pubkey: string
    entity: GCRMain | null // null means entity was newly created
}

// ? Maybe sanitize the options?
export default class HandleGCR {
    /** Mutex to serialize gcr_main writes and prevent deadlocks */
    static gcrWriteMutex = new Mutex()

    /**
     * Set of GCR transaction types that can be batch processed with in-mem
     * copies of the GCRMain entities.
     * These don't need a special rollback routine.
     */
    static GCRTxTypes = new Set([
        "balance",
        "nonce",
        "identity",
        // These ⌄⌄⌄ are here because they don't have implemented handlers
        "storageProgram",
        "tlsnotary",
        "subnetsTx",
        "assign",
        "escrow",
    ])

    static async getNativeStatus(
        publicKey: string,
        options: GetNativeStatusOptions = {
            balance: true,
            nonce: true,
            txList: false,
            identities: true,
            extended: false,
        },
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        // Getting the datasource
        const db = await Datasource.getInstance()
        const globalChangeRegistryRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        // Getting the status native data
        const globalChangeRegistrySearch =
            await globalChangeRegistryRepository.findOneBy({
                publicKey: publicKey,
            })
        if (!globalChangeRegistrySearch) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        const globalChangeRegistryData: GlobalChangeRegistry = {
            id: globalChangeRegistrySearch.id,
            publicKey: globalChangeRegistrySearch.publicKey,
            details: globalChangeRegistrySearch.details,
            extended: globalChangeRegistrySearch.extended,
        }
        // Selecting only the requested data
        if (options.balance) {
            globalChangeRegistryData.details.content.balance =
                globalChangeRegistrySearch.details.content.balance
        }
        if (options.nonce) {
            globalChangeRegistryData.details.content.nonce =
                globalChangeRegistrySearch.details.content.nonce
        }
        if (options.txList) {
            globalChangeRegistryData.details.content.txs =
                globalChangeRegistrySearch.details.content.txs
        }
        if (options.identities) {
            globalChangeRegistryData.details.content.identities =
                globalChangeRegistrySearch.details.content.identities
        }
        if (options.extended) {
            globalChangeRegistryData.extended =
                globalChangeRegistrySearch.extended
        }
        response.response = globalChangeRegistryData
        return response
    }

    static async getNativeProperties(
        publicKey: string,
        options: GetNativePropertiesOptions = {
            tokens: true,
            nfts: true,
            xm: true,
            web2: true,
            other: false,
        },
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        // Getting the datasource
        const db = await Datasource.getInstance()
        const gcrExtendedRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        // Getting the status properties data
        const repositorySearch = await gcrExtendedRepository.findOneBy({
            publicKey: publicKey,
        })
        const gcrExtendedSearch = repositorySearch.extended
        if (!gcrExtendedSearch) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        const gcrExtendedData: GCRExtended = {
            tokens: gcrExtendedSearch.tokens,
            nfts: gcrExtendedSearch.nfts,
            xm: gcrExtendedSearch.xm,
            web2: gcrExtendedSearch.web2,
            other: gcrExtendedSearch.other,
        }
        // Selecting only the requested data
        if (options.tokens) {
            gcrExtendedData.tokens = gcrExtendedSearch.tokens
        }
        if (options.nfts) {
            gcrExtendedData.nfts = gcrExtendedSearch.nfts
        }
        if (options.xm) {
            gcrExtendedData.xm = gcrExtendedSearch.xm
        }
        if (options.web2) {
            gcrExtendedData.web2 = gcrExtendedSearch.web2
        }
        response.response = gcrExtendedData
        return response
    }

    static async getNativeSubnetsTxs(
        subnetId: string,
        options: GetNativeSubnetsTxsOptions = {
            txData: true,
        },
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        const db = await Datasource.getInstance()
        const gcrSubnetsTxsRepository = db
            .getDataSource()
            .getRepository(GCRSubnetsTxs)
        // Getting the status subnets txs data
        const gcrSubnetsTxsSearch = await gcrSubnetsTxsRepository.findBy({
            subnet_id: subnetId,
        })
        if (!gcrSubnetsTxsSearch) {
            response.response = "Subnet not found"
            response.result = 404
            return response
        }
        // Preparing the response
        const gcrSubnetsTxsData: GCRSubnetsTxs[] = []
        // Selecting only the requested data
        if (!options.txData) {
            for (const tx of gcrSubnetsTxsSearch) {
                tx.tx_data = null
                gcrSubnetsTxsData.push(tx)
            }
        }
        response.response = gcrSubnetsTxsData
        return response
    }

    /**
     * Bulk update assignedTxs using raw SQL for efficiency
     */
    static async bulkUpdateAssignedTxs(
        updates: Map<string, string[]>,
    ): Promise<void> {
        if (updates.size === 0) return

        const db = await Datasource.getInstance()
        const queryRunner = db.getDataSource().createQueryRunner()

        try {
            // Build VALUES clause with proper escaping
            // assignedTxs is jsonb, so we use jsonb arrays and || operator for concatenation
            const valueEntries: string[] = []
            for (const [pubkey, txHashes] of updates.entries()) {
                const escapedPubkey = pubkey.replace(/'/g, "''")
                // Create a JSON array string for jsonb
                const jsonArray = JSON.stringify(txHashes).replace(/'/g, "''")
                valueEntries.push(
                    `('${escapedPubkey}'::text, '${jsonArray}'::jsonb)`,
                )
            }

            const sql = `
            UPDATE gcr_main AS g
            SET "assignedTxs" = COALESCE(g."assignedTxs", '[]'::jsonb) || v.new_txs,
                "updatedAt" = NOW()
            FROM (VALUES ${valueEntries.join(",\n")}) AS v(pubkey, new_txs)
            WHERE g.pubkey = v.pubkey
        `

            await queryRunner.query(sql)
        } finally {
            await queryRunner.release()
        }
    }

    /**
     * Loads all entities affected by given transactions into memory.
     * Pre-loads GCRMain accounts, StoragePrograms, and TLSNotary entries
     * in parallel for batch processing.
     *
     * @param txs Transactions to load entities for
     * @returns Caches for accounts, storage programs, and TLS notaries
     */
    static async prepareAccounts(txs: Transaction[]): Promise<GCREntityCaches> {
        const affectedPubkeys = new Set<string>()
        const affectedStorageAddresses = new Set<string>()
        const affectedTokenIds = new Set<string>()

        // Single pass to collect all keys
        for (const tx of txs) {
            const gcrEdits = tx.content.gcr_edits
            if (!gcrEdits || !Array.isArray(gcrEdits)) continue

            for (const edit of gcrEdits) {
                const editType = edit.type
                if (isBatchableGCREdit(edit)) {
                    const pubkey = normalizePubkey(edit.account)
                    affectedPubkeys.add(pubkey)
                } else if (editType === "storageProgram") {
                    affectedStorageAddresses.add(
                        (edit as unknown as GCREditStorageProgram).target,
                    )
                } else if (editType === "tlsnotary") {
                    affectedTokenIds.add(
                        (edit as unknown as GCREditTLSNotary).data.tokenId,
                    )
                }
            }

            if (tx.content?.from_ed25519_address) {
                affectedPubkeys.add(
                    normalizePubkey(tx.content.from_ed25519_address),
                )
            }
        }

        // Parallel DB loads
        const [gcrMainCache, storageProgramCache, tlsNotaryCache] =
            await Promise.all([
                this.loadGCRMainEntities(affectedPubkeys),
                this.loadStorageProgramEntities(affectedStorageAddresses),
                this.loadTLSNotaryEntities(affectedTokenIds),
            ])

        return {
            accounts: gcrMainCache,
            storagePrograms: storageProgramCache,
            tlsNotaries: tlsNotaryCache,
        }
    }

    private static async loadGCRMainEntities(
        pubkeys: Set<string>,
    ): Promise<Map<string, GCRMain>> {
        const cache = new Map<string, GCRMain>()
        if (pubkeys.size === 0) return cache

        const gcrMainRepo = dataSource.getRepository(GCRMain)
        const existing = await gcrMainRepo.find({
            where: { pubkey: In([...pubkeys]) },
        })

        for (const account of existing) {
            cache.set(account.pubkey, account)
        }

        // Create entities for missing accounts (unsaved)
        for (const pubkey of pubkeys) {
            if (!cache.has(pubkey)) {
                const newEntity = await HandleGCR.createAccount(
                    pubkey,
                    {},
                    true,
                )
                cache.set(pubkey, newEntity)
            }
        }

        return cache
    }

    private static async loadStorageProgramEntities(
        addresses: Set<string>,
    ): Promise<Map<string, GCRStorageProgram>> {
        const cache = new Map<string, GCRStorageProgram>()
        if (addresses.size === 0) return cache

        const repo = dataSource.getRepository(GCRStorageProgram)
        const existing = await repo.find({
            where: { storageAddress: In([...addresses]) },
        })

        for (const program of existing) {
            cache.set(program.storageAddress, program)
        }

        // Don't create missing entries — null means "doesn't exist yet"
        return cache
    }

    private static async loadTLSNotaryEntities(
        tokenIds: Set<string>,
    ): Promise<Map<string, GCRTLSNotary>> {
        const cache = new Map<string, GCRTLSNotary>()
        if (tokenIds.size === 0) return cache

        const repo = dataSource.getRepository(GCRTLSNotary)
        const existing = await repo.find({
            where: { tokenId: In([...tokenIds]) },
        })

        for (const entry of existing) {
            cache.set(entry.tokenId, entry)
        }

        // Don't create missing entries — null means "doesn't exist yet"
        return cache
    }

    /**
     * Executes a transaction, applying the GCR edits to in-memory entity caches.
     * Does not save the changes to the database or apply the side-effects.
     * Use together with HandleGCR.saveGCREditChanges() to save the changes to the database
     * and apply the side-effects.
     *
     * @param entities - Pre-loaded entity caches (accounts, storage programs, TLS notaries)
     * @param tx - The transaction to execute
     * @param isRollback - Whether the operation is a rollback
     * @param simulate - Whether the operation is being simulated (used for pre-consensus simulation)
     **/
    static async applyTransaction(
        entities: GCREntityCaches,
        tx: Transaction,
        isRollback: boolean,
        simulate: boolean,
    ): Promise<GCRApplyResult> {
        // Skip txs without GCR edits (valid but no state changes)
        if (
            !tx.content.gcr_edits ||
            !Array.isArray(tx.content.gcr_edits) ||
            tx.content.gcr_edits.length === 0
        ) {
            return {
                success: true,
                entities,
                message: "No GCR edits to apply",
                sideEffects: [],
                appliedEditsCount: 0,
            }
        }

        const gcrEdits = [...tx.content.gcr_edits]

        // INFO: Reverse order of gcr_edits for rollback
        if (isRollback) {
            gcrEdits.reverse()
        }

        // Capture snapshots for potential rollback
        const snapshots: GCRMainSnapshot[] = []
        const editPubkeys = new Set<string>()

        for (const edit of gcrEdits) {
            if (isBatchableGCREdit(edit)) {
                const pubkey = normalizePubkey(edit.account)
                if (!editPubkeys.has(pubkey)) {
                    editPubkeys.add(pubkey)
                    const entity = entities.accounts.get(pubkey)
                    snapshots.push({
                        pubkey,
                        entity: entity ? structuredClone(entity) : null,
                    })
                }
            }
        }
        const sideEffects: (() => Promise<void>)[] = []
        const appliedEdits: GCREdit[] = []

        // Apply all edits for this tx
        for (const edit of gcrEdits) {
            if (!simulate && tx.hash) {
                edit.txhash = tx.hash
            }

            let result: GCRResult

            try {
                result = await HandleGCR.applyGCREdit(
                    edit,
                    entities,
                    isRollback,
                    simulate,
                )
            } catch (error) {
                log.error(`[applyTransaction] Error applying GCREdit: ${error}`)
                result = {
                    success: false,
                    message: `Error applying GCREdit: ${error}`,
                }
            }

            if (!result.success) {
                // Rollback all snapshots for this tx
                for (const snap of snapshots) {
                    if (snap.entity === null) {
                        // Entity was newly created - restore to fresh state
                        const freshEntity = await HandleGCR.createAccount(
                            snap.pubkey,
                            {},
                            true,
                        )
                        entities.accounts.set(snap.pubkey, freshEntity)
                    } else {
                        entities.accounts.set(snap.pubkey, snap.entity)
                    }
                }

                // INFO: If on a serious run, rollback hard edits
                if (!simulate && !this.GCRTxTypes.has(edit.type)) {
                    await this.rollback(tx, entities, appliedEdits)
                }

                return {
                    success: false,
                    entities,
                    message: result.message,
                    sideEffects: [],
                    appliedEditsCount: 0,
                }
            }

            if (result.sideEffect) {
                sideEffects.push(result.sideEffect)
            }

            appliedEdits.push(edit)
        }

        // INFO: Process native side-effects
        // REVIEW: Post-processing hook for native transaction side-effects
        // This handles side-effects that aren't part of GCR edits (e.g., token creation)
        // Token creation happens during simulation (mempool entry) so user can immediately use it
        // The token is created optimistically - if tx fails consensus, token will expire unused
        if (simulate && !isRollback && tx.content.type === "native") {
            try {
                await this.processNativeSideEffects(tx, simulate)
            } catch (error) {
                log.error(
                    `[simulateOne] Error processing native side-effects: ${error}`,
                )
            }
        }

        return {
            success: true,
            entities,
            message: "Successfully applied GCR edits",
            sideEffects: sideEffects,
            appliedEditsCount: appliedEdits.length,
        }
    }

    /**
     * Apply transactions in bulk and save the changes to the database
     *
     * @param txs The transactions to apply
     * @param isRollback Whether the operation is a rollback
     * @param simulate Whether the operation is being simulated (used for pre-consensus simulation)
     *
     * @returns The successful and failed transactions
     */
    static async applyTransactions(txs: Transaction[], isRollback: boolean) {
        log.debug("Applying GCR Edits for merged mempool (batched)")
        const now = Date.now()

        const successfulTxs: string[] = []
        const failedTxs: string[] = []
        const entities = await this.prepareAccounts(txs)

        // Track assignedTxs updates for bulk SQL later
        const sideEffects: (() => Promise<void>)[] = []
        const assignedTxsUpdates = new Map<string, string[]>()

        // Sequential tx processing (in-memory for all entity types)
        for (const tx of txs) {
            const applyResult = await HandleGCR.applyTransaction(
                entities,
                tx,
                isRollback,
                false,
            )
            if (!applyResult.success) {
                failedTxs.push(tx.hash)
                continue
            }

            sideEffects.push(...applyResult.sideEffects)

            // Track assignedTxs update
            const sender = normalizePubkey(
                tx.content?.from_ed25519_address || tx.content.from,
            )
            if (sender && tx.hash) {
                if (!assignedTxsUpdates.has(sender)) {
                    assignedTxsUpdates.set(sender, [])
                }

                assignedTxsUpdates.get(sender).push(tx.hash)
            }

            successfulTxs.push(tx.hash)
        }

        await HandleGCR.gcrWriteMutex.runExclusive(async () => {
            await this.saveGCREditChanges(entities, sideEffects)
            // Bulk update assignedTxs via raw SQL
            if (assignedTxsUpdates.size > 0) {
                log.debug(
                    `[applyGCREditsFromMergedMempool] Updating ${assignedTxsUpdates.size} assignedTxs`,
                )
                await this.bulkUpdateAssignedTxs(assignedTxsUpdates)
            }
        })

        const end = Date.now()
        log.debug(
            `[applyGCREditsFromMergedMempool] Time taken: ${(end - now) / 1000} seconds to apply GCR edits for ${txs.length} txs`,
        )

        return { successfulTxs, failedTxs }
    }

    /**
     * Saves all in-memory entity caches to the database and applies side-effects.
     *
     * @param entities All entity caches to flush
     * @param sideEffects The side-effects to apply
     */
    static async saveGCREditChanges(
        entities: GCREntityCaches,
        sideEffects: (() => Promise<void>)[],
    ) {
        // Save GCRMain entities
        const entitiesToSave = entities.accounts.values().toArray()
        entitiesToSave.sort((a, b) => a.pubkey.localeCompare(b.pubkey))
        if (entitiesToSave.length > 0) {
            log.debug(
                `[saveGCREditChanges] Saving ${entitiesToSave.length} GCRMain entities`,
            )
            const gcrMainRepo = dataSource.getRepository(GCRMain)
            await gcrMainRepo.save(entitiesToSave)
        }

        // Save/delete GCRStorageProgram entities
        if (entities.storagePrograms.size > 0) {
            const spToSave: GCRStorageProgram[] = []
            const spToDelete: string[] = []
            for (const [key, entity] of entities.storagePrograms) {
                if (entity === null) {
                    spToDelete.push(key)
                } else {
                    spToSave.push(entity)
                }
            }

            const spRepo = dataSource.getRepository(GCRStorageProgram)
            if (spToSave.length > 0) {
                log.debug(
                    `[saveGCREditChanges] Saving ${spToSave.length} StorageProgram entities`,
                )
                await spRepo.save(spToSave)
            }
            if (spToDelete.length > 0) {
                log.debug(
                    `[saveGCREditChanges] Deleting ${spToDelete.length} StorageProgram entities`,
                )
                await spRepo.delete({ storageAddress: In(spToDelete) })
            }
        }

        // Save/delete GCRTLSNotary entities
        if (entities.tlsNotaries.size > 0) {
            const tlsToSave: GCRTLSNotary[] = []
            const tlsToDelete: string[] = []
            for (const [key, entity] of entities.tlsNotaries) {
                if (entity === null) {
                    tlsToDelete.push(key)
                } else {
                    tlsToSave.push(entity)
                }
            }

            const tlsRepo = dataSource.getRepository(GCRTLSNotary)
            if (tlsToSave.length > 0) {
                log.debug(
                    `[saveGCREditChanges] Saving ${tlsToSave.length} TLSNotary entities`,
                )
                await tlsRepo.save(tlsToSave)
            }
            if (tlsToDelete.length > 0) {
                log.debug(
                    `[saveGCREditChanges] Deleting ${tlsToDelete.length} TLSNotary entities`,
                )
                await tlsRepo.delete({ tokenId: In(tlsToDelete) })
            }
        }

        // INFO: Apply side-effects in sequence
        for (const sideEffect of sideEffects) {
            try {
                await sideEffect()
            } catch (error) {
                log.error(
                    `[saveGCREditChanges] Error applying side effect: ${error}`,
                )
            }
        }
    }

    // REVIEW Implement the execution of GCREdit objects
    // TODO Add this after the tx is synced in Sync.ts and in the consensus
    // ? Should we add the rollbacks here?
    // NOTE Once this is implemented, we can remove the old methods from gcr.ts and the other methods that overlap with this one

    /**
     * Applies a single GCR edit operation to the blockchain state
     *
     * @param editOperation The GCR edit to apply
     * @param tx The original transaction containing this edit
     * @param isRollback Whether the operation is a rollback
     * @param simulate Whether the operation is being simulated (used for pre-consensus simulation)
     *
     * @returns Result indicating success/failure and any error messages
     * also contains the modified entity.
     *
     * @throws database errors during repository operations
     */
    static async applyGCREdit(
        editOperation: GCREdit,
        entities: GCREntityCaches,
        isRollback = false,
        simulate = false,
    ): Promise<GCRResult> {
        // NOTE The rollbacks are applied within the single routines based on the isRollback flag
        if (isRollback) {
            editOperation.isRollback = true
        }

        let result: GCRResult

        // Resolve the account for GCRMain-based edits
        let account: GCRMain | null = null
        if (isBatchableGCREdit(editOperation)) {
            const pubkey = normalizePubkey(editOperation.account)
            account = entities.accounts.get(pubkey) ?? null
        }

        // Guard: balance, nonce, and identity edits require a valid account
        if (
            !account &&
            (editOperation.type === "balance" ||
                editOperation.type === "nonce" ||
                editOperation.type === "identity")
        ) {
            return {
                success: false,
                message: `Missing account for ${editOperation.type} edit`,
            }
        }

        // Applying the edit operations
        switch (editOperation.type) {
            case "balance":
                result = await GCRBalanceRoutines.apply(editOperation, account)
                break
            case "nonce":
                result = await GCRNonceRoutines.apply(editOperation, account)
                break
            case "identity":
                result = await GCRIdentityRoutines.apply(editOperation, account)
                break
            case "assign":
            case "subnetsTx":
                // TODO implementations
                log.debug(`Assigning GCREdit ${editOperation.type}`)
                result = { success: true, message: "Not implemented" }
                break
            case "smartContract":
            case "escrow":
                // TODO implementations
                log.debug(`GCREdit ${editOperation.type} not yet implemented`)
                result = { success: true, message: "Not implemented" }
                break
            case "storageProgram": {
                const spEdit = editOperation as GCREditStorageProgram
                const spEntity = entities.storagePrograms.get(spEdit.target)
                result = await GCRStorageProgramRoutines.apply(
                    editOperation,
                    spEntity ?? null,
                    simulate,
                )
                if (
                    result.success &&
                    result.storageProgram !== undefined &&
                    result.storageProgram !== spEntity
                ) {
                    entities.storagePrograms.set(
                        spEdit.target,
                        result.storageProgram,
                    )
                }
                break
            }
            case "tlsnotary": {
                const tlsEdit = editOperation as GCREditTLSNotary
                const tlsEntity = entities.tlsNotaries.get(tlsEdit.data.tokenId)
                result = await GCRTLSNotaryRoutines.apply(
                    editOperation,
                    tlsEntity ?? null,
                    simulate,
                )

                if (
                    result.success &&
                    result.tlsNotary !== undefined &&
                    result.tlsNotary !== tlsEntity
                ) {
                    entities.tlsNotaries.set(
                        tlsEdit.data.tokenId,
                        result.tlsNotary,
                    )
                }
                break
            }

            default:
                return { success: false, message: "Invalid GCREdit type" }
        }

        return result
    }

    // /**
    //  * Applies all GCR edits from a transaction
    //  * @param tx Transaction containing GCR edits to apply
    //  * @param isRollback Whether the operation is a rollback
    //  * @param simulate Whether the operation is being simulated (used for pre-consensus simulation)
    //  * @returns Combined result of all edit applications
    //  * @throws May throw if any edit application fails
    //  */
    // static async applyToTx(
    //     tx: Transaction,
    //     isRollback = false,
    //     simulate = false,
    // ): Promise<GCRResult> {
    //     const editsResults: GCRResult[] = []
    //     const txExists = await Chain.checkTxExists(tx.hash)
    //     if (txExists) {
    //         return {
    //             success: false,
    //             message: "Transaction already executed",
    //         }
    //     }

    //     // const accounts = await this.prepareAccounts([tx])
    //     // return await HandleGCR.simulateOne(accounts, tx, isRollback, simulate)

    //     log.debug(
    //         "[applyToTx] Starting execution of " +
    //             tx.content.gcr_edits.length +
    //             " GCREdits",
    //     )
    //     // Keep track of applied edits to be able to rollback them
    //     const appliedEdits: GCREdit[] = []
    //     for (const edit of tx.content.gcr_edits) {
    //         // REVIEW: Ensure txhash is set on each GCR edit from the transaction
    //         // This is needed because client-side GCR edits don't have the txhash
    //         // (it's cleared during validation for hash comparison)
    //         if (!simulate) {
    //             edit.txhash = tx.hash
    //         }

    //         log.debug("[applyToTx] Executing GCREdit: " + edit.type)
    //         try {
    //             const result = await HandleGCR.apply(edit, tx, simulate)
    //             log.debug(
    //                 "[applyToTx] GCREdit executed: " +
    //                     edit.type +
    //                     " with result: " +
    //                     result.success +
    //                     " and message: " +
    //                     result.message,
    //             )
    //             // If not successful, we stop the execution
    //             if (!result.success) {
    //                 await this.rollback(tx, appliedEdits) // Rollback the applied edits
    //                 throw new Error(
    //                     "GCREdit failed for " +
    //                         edit.type +
    //                         " with message: " +
    //                         result.message,
    //                 )
    //             }
    //             editsResults.push(result)
    //             appliedEdits.push(edit) // Keep track of applied edits
    //         } catch (e) {
    //             log.error("[applyToTx] Error applying GCREdit: " + e)
    //             editsResults.push({
    //                 success: false,
    //                 message: `${e}`,
    //             })
    //             await this.rollback(tx, appliedEdits) // Rollback the applied edits
    //             // Stopping the execution
    //             if (!simulate) {
    //                 break
    //             }
    //         }
    //     }

    //     if (!editsResults.every(result => result.success)) {
    //         log.error("[applyToTx] Failed to apply GCREdit")
    //         const failedMessages = editsResults
    //             .filter(result => !result.success)
    //             .map(result => result.message)
    //             .join(", ")

    //         return {
    //             success: false,
    //             message: failedMessages,
    //         }
    //     }

    //     // REVIEW: Post-processing hook for native transaction side-effects
    //     // This handles side-effects that aren't part of GCR edits (e.g., token creation)
    //     // Token creation happens during simulation (mempool entry) so user can immediately use it
    //     // The token is created optimistically - if tx fails consensus, token will expire unused
    //     if (!isRollback && tx.content.type === "native") {
    //         try {
    //             await this.processNativeSideEffects(tx, simulate)
    //         } catch (sideEffectError) {
    //             log.error(
    //                 `[applyToTx] Native side-effect error (non-fatal): ${sideEffectError}`,
    //             )
    //             // Side-effect errors are logged but don't fail the transaction
    //             // The GCR edits (fee burning) have already been applied
    //         }
    //     }

    //     return { success: true, message: "" }
    // }

    /**
     * Process side-effects for native transactions that aren't captured in GCR edits
     * Currently handles:
     * - tlsn_request: Creates attestation token when tx enters mempool (simulate=true)
     *                 so user can immediately use the proxy
     *
     * Token creation is idempotent - if token already exists for this tx, it's skipped
     */
    private static async processNativeSideEffects(
        tx: Transaction,
        simulate = false,
    ): Promise<void> {
        const nativeData = tx.content.data as ["native", INativePayload]
        const nativePayload = nativeData[1]

        // Validate args exists before any destructuring
        if (!nativePayload.args || !Array.isArray(nativePayload.args)) {
            log.error(
                `[TLSNotary] Invalid nativePayload.args: ${JSON.stringify(nativePayload.args)}`,
            )
            return
        }

        switch (nativePayload.nativeOperation) {
            case "tlsn_request": {
                const [targetUrl] = nativePayload.args

                // Only create token once - during simulation (mempool entry)
                // Skip if called again during block finalization
                if (!simulate) {
                    log.debug(
                        `[TLSNotary] Skipping token creation for finalized tx ${tx.hash} (already created at mempool entry)`,
                    )
                    break
                }

                log.info(
                    `[TLSNotary] Processing tlsn_request side-effect for ${targetUrl}`,
                )

                // Validate URL and extract domain
                const domain = extractDomain(targetUrl)
                log.debug(`[TLSNotary] Domain extracted: ${domain}`)

                // Create the attestation token (idempotent - tokenManager handles duplicates)
                const token = createToken(
                    tx.content.from as string,
                    targetUrl,
                    tx.hash,
                )
                log.info(
                    `[TLSNotary] Created token ${token.id} for tx ${tx.hash}`,
                )
                break
            }
            // tlsn_store side-effects are handled in GCRTLSNotaryRoutines.apply()
            default:
                // No side-effects for other native operations
                break
        }
    }

    /**
     * Rolls back a transaction by reversing the order of applied GCR edits
     * @param tx The transaction to rollback
     * @param appliedEditsOriginal The original list of applied GCR edits
     * @returns Result indicating success/failure and any error messages
     * @throws May throw if any edit rollback fails
     */
    static async rollback(
        tx: Transaction,
        entities: GCREntityCaches,
        appliedEditsOriginal: GCREdit[],
    ): Promise<void> {
        // We need to reverse the order of the applied edits
        const appliedEdits = appliedEditsOriginal.reverse()
        log.info(
            "[rollback] Rolling back " +
                appliedEdits.length +
                " GCREdits for tx: " +
                tx.hash,
        )
        // To rollback the edits, we need to pass the rollback flag to the apply method
        const counter = 0
        const results: GCRResult[] = []

        for (const edit of appliedEdits) {
            log.debug(
                "[rollback] (" +
                    counter +
                    "/" +
                    appliedEdits.length +
                    ") Rolling back GCREdit: " +
                    edit.type,
            )

            let result: GCRResult

            try {
                result = await this.applyGCREdit(edit, entities, true)
            } catch (error) {
                log.error(`[rollback] Error applying GCREdit: ${error}`)
                result = {
                    success: false,
                    message: `Error applying GCREdit: ${error}`,
                }
            }

            results.push(result)
        }
        log.info(
            "[rollback] Rolled back " +
                counter +
                " GCREdits for tx: " +
                tx.hash,
        )
    }

    // ! SECTION GCREdit methods

    // Assign methods // ? Probably to remove

    // TODO We have to port these methods from gcr.ts, now they are just proxies
    assign = {
        xm: assignXM,
        web2: assignWeb2,
        identity: {
            assignFromWrite: IdentityManager.inferIdentityFromWrite,
        },
    }

    // This is a proxy to the manageNative methods for simplicity
    native = manageNative

    // Utilities
    utilities = {
        ensureGCRForUser,
    }

    // State save methods
    save = gcrStateSave

    // Hash methods
    hash = {
        tables: hashGCRTables,
    }

    // JSONB methods
    jsonb = {
        get: GCRJsonbHandler.getJSONBValue,
        update: GCRJsonbHandler.updateJSONBValue,
    }

    private static async getRepositories() {
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()

        return {
            main: dataSource.getRepository(GCRMain),
            hashes: dataSource.getRepository(GCRHashes),
            subnetsTxs: dataSource.getRepository(GCRSubnetsTxs),
            tracker: dataSource.getRepository(GCRTracker),
            tlsnotary: dataSource.getRepository(GCRTLSNotary),
            storageProgram: dataSource.getRepository(GCRStorageProgram),
        }
    }

    // Create methods
    /**
     * Creates a new GCRMain account.
     * If fillData is provided, the account will be created with the provided data.
     *
     * @param pubkey The public key of the account
     * @param fillData Optional data to fill in the account
     * @param skipSave If true, returns the entity without saving to database (for batch operations)
     * @returns The created GCRMain account
     */
    public static createAccount = async (
        pubkey: string,
        fillData: Record<string, any> = {},
        skipSave = false,
    ): Promise<GCRMain> => {
        if (
            !pubkey ||
            typeof pubkey !== "string" ||
            pubkey.trim().length === 0
        ) {
            throw new Error("Invalid public key provided")
        }

        const account = new GCRMain()

        account.pubkey = pubkey
        account.balance = fillData["balance"] || 0n
        account.identities = fillData["identities"] || {
            xm: {},
            web2: {},
            pqc: {},
            ud: [],
        }

        account.assignedTxs = []
        account.nonce = fillData["nonce"] || 0
        account.points = fillData["points"] || {
            totalPoints: 0,
            breakdown: {
                web3Wallets: {},
                socialAccounts: {
                    twitter: 0,
                    github: 0,
                    discord: 0,
                },
                referrals: 0,
                demosFollow: 0,
            },
            lastUpdated: new Date(),
        }

        account.referralInfo = fillData["referralInfo"] || {
            totalReferrals: 0,
            referralCode: Referrals.generateReferralCode(pubkey),
            referrals: [],
            referredBy: null,
        }
        account.flagged = fillData["flagged"] || false
        account.flaggedReason = fillData["flaggedReason"] || ""
        account.reviewed = fillData["reviewed"] || false
        account.createdAt = fillData["createdAt"] || new Date()
        account.updatedAt = fillData["updatedAt"] || new Date()

        if (skipSave) {
            return account
        }

        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()
        const repository = dataSource.getRepository(GCRMain)
        return await repository.save(account)
    }

    /**
     * Applies a GCREdit operation directly to an entity without database operations.
     * Used for batch processing where DB operations are deferred.
     *
     * @param editOperation The GCR edit to apply
     * @param entity The GCRMain entity to modify
     * @returns Result indicating success/failure
     */
    public static applyToEntity(
        editOperation: GCREdit,
        entity: GCRMain,
    ): GCRResult {
        // Only balance and nonce types have the 'account' property and are supported
        if (
            editOperation.type !== "balance" &&
            editOperation.type !== "nonce"
        ) {
            return {
                success: false,
                message: `Unsupported edit type for batch processing: ${editOperation.type}`,
            }
        }

        // Now TypeScript knows editOperation is balance or nonce type which have 'account'
        const editOperationAccount =
            typeof editOperation.account !== "string"
                ? forgeToHex(editOperation.account)
                : editOperation.account

        if (entity.pubkey !== editOperationAccount) {
            return { success: false, message: "Entity pubkey mismatch" }
        }

        if (editOperation.type === "balance") {
            return GCRBalanceRoutines.applyToEntity(editOperation, entity)
        } else {
            return GCRNonceRoutines.applyToEntity(editOperation, entity)
        }
    }

    /**
     * Makes the getRepositories method public for batch operations
     */
    public static async getRepositoriesPublic() {
        return this.getRepositories()
    }
}
