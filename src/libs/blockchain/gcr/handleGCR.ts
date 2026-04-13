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
import { GCREdit } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

// REVIEW Trying to use the new GCRv2
import { GCRMain } from "src/model/entities/GCRv2/GCR_Main"
import { GCRTracker } from "src/model/entities/GCR/GCRTracker"
import GCRBalanceRoutines from "./gcr_routines/GCRBalanceRoutines"
import GCRNonceRoutines from "./gcr_routines/GCRNonceRoutines"

import Chain from "../chain"
import { EntityManager, In, Repository } from "typeorm"
import { Mutex } from "async-mutex"
import GCRIdentityRoutines from "./gcr_routines/GCRIdentityRoutines"
import { GCRTLSNotaryRoutines } from "./gcr_routines/GCRTLSNotaryRoutines"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
// REVIEW: Token GCREdit routines
import GCRTokenRoutines from "./gcr_routines/GCRTokenRoutines"
import { GCRToken } from "@/model/entities/GCRv2/GCR_Token"
import { GCREditToken, ExtendedGCREdit, isGCREditToken } from "./types/Token"
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
    sideEffect?: () => Promise<void>
    response?: any
}

export interface GCRApplyResult {
    success: boolean
    accounts: Map<string, GCRMain>
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
     * Loads accounts affected by given transactions into memory
     *
     * @param txs Transactions to load accounts for
     * @returns Map of pubkeys to GCRMain entities
     */
    static async prepareAccounts(
        txs: Transaction[],
    ): Promise<Map<string, GCRMain>> {
        const affectedPubkeys = new Set<string>()

        for (const tx of txs) {
            const gcrEdits = tx.content.gcr_edits
            if (!gcrEdits || !Array.isArray(gcrEdits)) continue

            for (const edit of gcrEdits) {
                if (isBatchableGCREdit(edit)) {
                    const pubkey = normalizePubkey(edit.account)
                    affectedPubkeys.add(pubkey)
                }
            }

            if (tx.content?.from_ed25519_address) {
                affectedPubkeys.add(
                    normalizePubkey(tx.content.from_ed25519_address),
                )
            }
        }

        // Batch load all affected GCRMain entities
        const gcrMainRepo = dataSource.getRepository(GCRMain)
        const gcrMainCache = new Map<string, GCRMain>()

        if (affectedPubkeys.size > 0) {
            const existingAccounts = await gcrMainRepo.find({
                where: { pubkey: In([...affectedPubkeys]) },
            })

            for (const account of existingAccounts) {
                gcrMainCache.set(account.pubkey, account)
            }

            // Create entities for missing accounts (unsaved)
            for (const pubkey of affectedPubkeys) {
                if (!gcrMainCache.has(pubkey)) {
                    const newEntity = await HandleGCR.createAccount(
                        pubkey,
                        {},
                        true,
                    )
                    gcrMainCache.set(pubkey, newEntity)
                }
            }
        }

        return gcrMainCache
    }

    /**
     * Executes a transaction, applying the GCR edits to in-memory copies of the GCRMain entities
     * Does not save the changes to the database or apply the side-effects
     * Use together with HandleGCR.saveGCREditChanges() to save the changes to the database
     * and apply the side-effects
     *
     * @param accounts - A map of pubkeys to GCRMain entities
     * @param tx - The transaction to execute
     * @param isRollback - Whether the operation is a rollback
     * @param simulate - Whether the operation is being simulated (used for pre-consensus simulation)
     **/
    static async applyTransaction(
        accounts: Map<string, GCRMain>,
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
            // successfulTxs.push(tx.hash)
            // continue
            return {
                success: true,
                accounts: accounts,
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
                    const entity = accounts.get(pubkey)
                    snapshots.push({
                        pubkey,
                        entity: entity ? structuredClone(entity) : null,
                    })
                }
            }
        }
        const sideEffects: (() => Promise<void>)[] = []
        const appliedEdits: GCREdit[] = []

        // Apply all batchable edits for this tx
        for (const edit of gcrEdits) {
            let entity: GCRMain | null = null
            if (isBatchableGCREdit(edit)) {
                const pubkey = normalizePubkey(edit.account)
                entity = accounts.get(pubkey)
            }

            let result: GCRResult

            try {
                result = await HandleGCR.applyGCREdit(
                    edit,
                    entity,
                    isRollback,
                    simulate,
                    tx,
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
                        accounts.set(snap.pubkey, freshEntity)
                    } else {
                        accounts.set(snap.pubkey, snap.entity)
                    }
                }

                // INFO: If on a serious run, rollback hard edits
                if (!simulate && !this.GCRTxTypes.has(edit.type)) {
                    await this.rollback(tx, accounts, appliedEdits)
                }

                return {
                    success: false,
                    accounts: accounts,
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
            accounts: accounts,
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
        let gcrMainCache = await this.prepareAccounts(txs)

        // Track assignedTxs updates for bulk SQL later
        const sideEffects: (() => Promise<void>)[] = []
        const assignedTxsUpdates = new Map<string, string[]>()

        // Sequential tx processing (in-memory for batchable edits)
        for (const tx of txs) {
            const simulateResult = await HandleGCR.applyTransaction(
                gcrMainCache,
                tx,
                isRollback,
                false,
            )
            if (!simulateResult.success) {
                failedTxs.push(tx.hash)
                continue
            }

            gcrMainCache = simulateResult.accounts

            if (simulateResult.success) {
                sideEffects.push(...simulateResult.sideEffects)

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
        }

        await HandleGCR.gcrWriteMutex.runExclusive(async () => {
            await this.saveGCREditChanges(gcrMainCache, sideEffects)
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
     * Saves the GCR edits to the database and applies the side-effects
     *
     * @param accounts The accounts to save
     * @param sideEffects The side-effects to apply
     */
    static async saveGCREditChanges(
        accounts: Map<string, GCRMain>,
        sideEffects: (() => Promise<void>)[],
    ) {
        const entitiesToSave = accounts.values().toArray()
        entitiesToSave.sort((a, b) => a.pubkey.localeCompare(b.pubkey))
        if (entitiesToSave.length > 0) {
            log.debug(
                `[applyGCREditsFromMergedMempool] Saving ${entitiesToSave.length} entities`,
            )
            const gcrMainRepo = dataSource.getRepository(GCRMain)
            await gcrMainRepo.save(entitiesToSave)
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
        editOperation: ExtendedGCREdit,
        account: GCRMain | null,
        isRollback = false, // operations will be reverse in the rollback
        simulate = false, // used to simulate the GCREdit application
        tx?: Transaction, // REVIEW: Optional transaction context for token hook execution
    ): Promise<GCRResult> {
        const repositories = await this.getRepositories()

        // NOTE The rollbacks are applied within the single routines based on the isRollback flag
        if (isRollback) {
            editOperation.isRollback = true
        }
        // REVIEW: Handle token operations first (SDK GCREdit does not include token type yet)
        // REVIEW: Phase 5.1 - Pass transaction for script execution context
        if (isGCREditToken(editOperation)) {
            return GCRTokenRoutines.apply(
                editOperation,
                repositories.token as Repository<GCRToken>,
                simulate,
                tx, // Pass transaction for hook execution context
            )
        }

        // Cast to SDK GCREdit for the switch statement
        const sdkEdit = editOperation as GCREdit

        let result: GCRResult

        // Guard: balance, nonce, and identity edits require a valid account
        if (!account && (editOperation.type === "balance" || editOperation.type === "nonce" || editOperation.type === "identity")) {
            return { success: false, message: `Missing account for ${editOperation.type} edit` }
        }

        // Applying the edit operations
        switch (sdkEdit.type) {
            case "balance":
                result = await GCRBalanceRoutines.apply(editOperation, account!)
                break
            case "nonce":
                result = await GCRNonceRoutines.apply(editOperation, account!)
                break
            case "identity":
                result = await GCRIdentityRoutines.apply(editOperation, account!)
                break
            case "assign":
            case "subnetsTx":
                // TODO implementations
                log.debug(`Assigning GCREdit ${sdkEdit.type}`)
                return { success: true, message: "Not implemented" }
            case "smartContract":
            case "escrow":
                // TODO implementations
                log.debug(`GCREdit ${sdkEdit.type} not yet implemented`)
                return { success: true, message: "Not implemented" }
            // REVIEW: StorageProgram unified storage operations
            case "storageProgram":
                return GCRStorageProgramRoutines.apply(
                    sdkEdit,
                    repositories.storageProgram as Repository<GCRStorageProgram>,
                    simulate,
                )
            // REVIEW: TLSNotary attestation proof storage
            case "tlsnotary":
                return GCRTLSNotaryRoutines.apply(
                    sdkEdit,
                    repositories.tlsnotary as Repository<GCRTLSNotary>,
                    simulate,
                )
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
     * Apply only token-related GCR edits for a transaction.
     *
     * Rationale:
     * - Token state is not currently included in the GCR integrity hash used during consensus.
     * - During consensus forging, some nodes may not have the full mempool/tx set yet, causing token tables
     *   to diverge if token edits are applied pre-forge.
     * - This helper allows consensus to validate token edits (simulate=true) and later apply them deterministically
     *   from the finalized block tx list, without coupling to Chain.checkTxExists().
     */
    static async applyTokenEditsToTx(
        tx: Transaction,
        isRollback = false,
        simulate = false,
        entityManager?: EntityManager,
    ): Promise<GCRResult> {
        const tokenEdits = Array.isArray(tx?.content?.gcr_edits)
            ? (tx.content.gcr_edits as any[]).filter(e => e?.type === "token")
            : []

        if (tokenEdits.length === 0) {
            return { success: true, message: "" }
        }

        if (entityManager) {
            const tokenRepo = entityManager.getRepository(GCRToken)
            for (const edit of tokenEdits) {
                const editOp = { ...(edit as any) }
                if (isRollback) editOp.isRollback = true
                const result = await GCRTokenRoutines.apply(editOp as any, tokenRepo, simulate, tx)
                if (!result.success) return result
            }
            return { success: true, message: "" }
        }

        // REVIEW: Fallback path without EntityManager — use default repository
        const repositories = await this.getRepositories()
        const tokenRepo = repositories.token as Repository<GCRToken>
        for (const edit of tokenEdits) {
            const editOp = { ...(edit as any) }
            if (isRollback) editOp.isRollback = true
            const result = await GCRTokenRoutines.apply(editOp as any, tokenRepo, simulate, tx)
            if (!result.success) return result
        }

        return { success: true, message: "" }
    }

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
        accounts: Map<string, GCRMain>,
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
            let account: GCRMain | null = null
            if (isBatchableGCREdit(edit)) {
                const pubkey = normalizePubkey(edit.account)
                account = accounts.get(pubkey)
            }

            let result: GCRResult

            try {
                result = await this.applyGCREdit(edit, account, true, false, tx)
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
            token: dataSource.getRepository(GCRToken),
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
        account.extended = fillData["extended"] || {
            tokens: [],
            nfts: [],
            xm: [],
            web2: [],
            other: [],
        }
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
