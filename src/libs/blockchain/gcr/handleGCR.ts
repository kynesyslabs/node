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

import _ from "lodash"

import { Transaction, TransactionContent } from "@kynesyslabs/demosdk/types"
import Datasource, { dataSource } from "src/model/datasource"
import { GCREdit, GCREditStorageProgram } from "@kynesyslabs/demosdk/types"
import {
    GCREditBalance,
    GCREditIdentity,
    GCREditNonce,
    GCREditTLSNotary,
} from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"
import log from "src/utilities/logger"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

// REVIEW Trying to use the new GCRv2
import { GCRMain } from "src/model/entities/GCRv2/GCR_Main"
import { GCRAssignedTx } from "src/model/entities/GCRv2/GCRAssignedTx"
import { CHUNK_ASSIGNED_TXS } from "src/libs/blockchain/chainDb"
import Chain from "src/libs/blockchain/chain"
import { isForkActive } from "@/forks"
import { getSharedState } from "@/utilities/sharedState"
import { verifyGcrEditsMatch } from "src/libs/blockchain/validation/verifyGcrEdits"
import GCRBalanceRoutines from "./gcr_routines/GCRBalanceRoutines"
import GCRNonceRoutines from "./gcr_routines/GCRNonceRoutines"
import GCRValidatorStakeRoutines from "./gcr_routines/GCRValidatorStakeRoutines"

import { In } from "typeorm"
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

/** Per-assignment record for the gcr_assigned_txs relation. */
export interface AssignedTxRecord {
    txHash: string
    blockNumber: number
}

type IndexedSideEffect = {
    txIndex: number
    fn: () => Promise<void>
}

/**
 * Type guard to check if a GCREdit targets GCRMain (can be batch processed)
 * Returns true for balance and nonce types which have the 'account' property
 */
export function isGCRMainEdit(
    edit: GCREdit,
): edit is GCREditBalance | GCREditNonce | GCREditIdentity {
    const gcrMainEdits = new Set(["balance", "nonce", "identity"])
    return gcrMainEdits.has(edit.type)
}

/**
 * Helper to normalize pubkey from different formats
 */
export function normalizePubkey(account: string | Uint8Array): string {
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
        "subnetsTx",
        "assign",
        "escrow",
    ])

    /**
     * Record (pubkey, txHash, blockNumber) assignments into gcr_assigned_txs.
     *
     * Replaces the previous design where these tuples were appended to a
     * jsonb array on gcr_main. The append-rewrite pattern caused unbounded
     * TOAST churn (see MoveAssignedTxsToOwnTable migration for context).
     *
     * Idempotent via the (pubkey, tx_hash) primary key + orIgnore() — safe
     * during rollback or replay where the same (pubkey, tx) pair recurs.
     */
    static async bulkUpdateAssignedTxs(
        updates: Map<string, AssignedTxRecord[]>,
    ): Promise<void> {
        if (updates.size === 0) return

        const rows: { pubkey: string; txHash: string; blockNumber: number }[] =
            []
        for (const [pubkey, records] of updates.entries()) {
            for (const r of records) {
                rows.push({
                    pubkey,
                    txHash: r.txHash,
                    blockNumber: r.blockNumber,
                })
            }
        }
        if (rows.length === 0) return

        const repo = dataSource.getRepository(GCRAssignedTx)
        for (let i = 0; i < rows.length; i += CHUNK_ASSIGNED_TXS) {
            const chunk = rows.slice(i, i + CHUNK_ASSIGNED_TXS)
            await repo
                .createQueryBuilder()
                .insert()
                .values(chunk)
                .orIgnore()
                .execute()
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
    static async prepareEntities(txs: Transaction[]): Promise<GCREntityCaches> {
        const affectedPubkeys = new Set<string>()
        const affectedStorageAddresses = new Set<string>()
        const affectedTokenIds = new Set<string>()

        // Single pass to collect all keys
        for (const tx of txs) {
            const gcrEdits = tx.content.gcr_edits
            if (!gcrEdits || !Array.isArray(gcrEdits)) continue

            for (const edit of gcrEdits) {
                const editType = edit.type
                if (isGCRMainEdit(edit)) {
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

        // AUDIT C1 (apply-side, defense in depth): re-derive the expected
        // gcr_edits from the signed body and refuse to APPLY a native tx whose
        // shipped edits don't match. The ingress guard (Mempool.receive) blocks
        // forged edits at admission, but a node also applies edits from blocks
        // it SYNCS (Sync.ts -> syncGCRTables -> applyTransactions), which never
        // pass through local mempool admission. Without this, a malicious
        // proposer's forged-edit tx, once in a block, is applied verbatim on
        // sync. This is the consensus-critical boundary net.
        //
        // Gated:
        //   - native txs only (others carry no balance edits to forge);
        //   - not on simulate (pre-consensus dry run) or rollback (rollback
        //     intentionally replays the stored edits in reverse);
        //   - fork-gated on nonceEnforcement (active @0 on fresh chains) so
        //     pre-fork apply is byte-identical for re-sync safety.
        //   - works under gasFeeSeparation too: verifyGcrEditsMatch reproduces
        //     the node-computed fee edits on the regen side (audit 184), so the
        //     binding stays live when that fork is active instead of going dark.
        if (
            !simulate &&
            !isRollback &&
            tx.content.type === "native" &&
            isForkActive(
                "nonceEnforcement",
                getSharedState.lastBlockNumber ?? 0,
            )
        ) {
            // Own the fork check at the call site (matches Mempool.receive)
            // so both ingress + apply decide expectFeeEdits the same way and
            // neither relies on verifyGcrEditsMatch's internal re-check
            // (Greptile P2). A confirmed/applied tx carries fee edits exactly
            // when gasFeeSeparation is active.
            const expectFeeEdits = isForkActive(
                "gasFeeSeparation",
                getSharedState.lastBlockNumber ?? 0,
            )
            const { match } = await verifyGcrEditsMatch(tx, {
                expectFeeEdits,
            })
            if (!match) {
                log.error(
                    `[applyTransaction] Refusing to apply tx ${tx.hash}: gcr_edits do not match regenerated set (forged-edit guard)`,
                )
                return {
                    success: false,
                    entities,
                    message: "GCREdit mismatch",
                    sideEffects: [],
                    appliedEditsCount: 0,
                }
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
            if (isGCRMainEdit(edit)) {
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
     * Partition transactions into groups such that no two groups share any
     * affected entity (pubkey, storage address, or TLS token id). Uses
     * union-find over namespaced entity keys. Transactions with no touched
     * entity each become their own independent group.
     *
     * Within a group, sequential application preserves ordering semantics
     * (e.g. nonce increments on a shared account). Across groups,
     * application is safe to run concurrently.
     *
     * Exposed (not private) to enable direct unit testing.
     */
    static partitionIndependentTxs(txs: Transaction[]): Transaction[][] {
        const now = Date.now()
        const parent = new Map<string, string>()
        const addKey = (k: string) => {
            if (!parent.has(k)) parent.set(k, k)
        }
        const find = (x: string): string => {
            let root = x
            while (parent.get(root) !== root) {
                root = parent.get(root)
            }
            let cur = x
            while (parent.get(cur) !== root) {
                const next = parent.get(cur)
                parent.set(cur, root)
                cur = next
            }
            return root
        }
        const union = (a: string, b: string) => {
            const ra = find(a)
            const rb = find(b)
            if (ra !== rb) parent.set(ra, rb)
        }

        const txKeys: string[][] = new Array(txs.length)
        for (let i = 0; i < txs.length; i++) {
            const tx = txs[i]
            const keys: string[] = []

            const gcrEdits = tx.content.gcr_edits
            if (Array.isArray(gcrEdits)) {
                for (const edit of gcrEdits) {
                    // NOTE: `assign`, `subnetsTx`, `escrow`, `smartContract`
                    // are NOT matched by isGCRMainEdit. They are currently
                    // stubbed in applyGCREdit and touch no entity caches.
                    // Grouping by tx sender alone is sufficient today. When
                    // implemented, extend this extractor if they touch any
                    // entity cache.
                    if (isGCRMainEdit(edit)) {
                        keys.push("acc:" + normalizePubkey(edit.account))
                    } else if (edit.type === "storageProgram") {
                        const spEdit = edit as unknown as GCREditStorageProgram
                        keys.push("sp:" + spEdit.target)
                        // Conservative: key by context.sender in case the
                        // routine ever touches the sender's account.
                        if (spEdit.context?.sender) {
                            keys.push("acc:" + spEdit.context.sender)
                        }
                    } else if (edit.type === "tlsnotary") {
                        const tlsEdit = edit as unknown as GCREditTLSNotary
                        keys.push("tls:" + tlsEdit.data.tokenId)
                        // Conservative: tlsnotary edits carry an account
                        // field; key it even though today's routine only
                        // touches entities.tlsNotaries.
                        if (tlsEdit.account) {
                            keys.push("acc:" + normalizePubkey(tlsEdit.account))
                        }
                    }
                }
            }

            if (tx.content?.from_ed25519_address) {
                keys.push(
                    "acc:" + normalizePubkey(tx.content.from_ed25519_address),
                )
            }

            for (const k of keys) addKey(k)
            for (let j = 1; j < keys.length; j++) union(keys[0], keys[j])
            txKeys[i] = keys
        }

        const groups = new Map<string, Transaction[]>()
        for (let i = 0; i < txs.length; i++) {
            const keys = txKeys[i]
            const bucket =
                keys.length > 0 ? find(keys[0]) : `__independent_${i}__`
            let group = groups.get(bucket)
            if (!group) {
                group = []
                groups.set(bucket, group)
            }
            group.push(txs[i])
        }

        const end = Date.now()
        log.only(
            `[partitionIndependentTxs] Time taken: ${end - now}ms for ${txs.length} txs`,
        )

        return [...groups.values()]
    }

    static async runGroup(
        group: Transaction[],
        entities: GCREntityCaches,
        isRollback: boolean,
        txIndex: Map<string, number>,
    ) {
        const successful: string[] = []
        const failed: string[] = []
        const sideEffects: IndexedSideEffect[] = []
        const assignedTxs = new Map<string, AssignedTxRecord[]>()

        for (let j = 0; j < group.length; j++) {
            if (j > 0 && j % 8 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve))
            }

            const tx = group[j]
            const applyResult = await HandleGCR.applyTransaction(
                entities,
                tx,
                isRollback,
                false,
            )
            if (!applyResult.success) {
                failed.push(tx.hash)
                continue
            }

            const idx = txIndex.get(tx.hash)
            for (const fn of applyResult.sideEffects) {
                sideEffects.push({ txIndex: idx, fn })
            }

            const sender = normalizePubkey(
                tx.content?.from_ed25519_address || tx.content.from,
            )
            if (sender && tx.hash) {
                let bucket = assignedTxs.get(sender)
                if (!bucket) {
                    bucket = []
                    assignedTxs.set(sender, bucket)
                }
                bucket.push({
                    txHash: tx.hash,
                    blockNumber: tx.blockNumber ?? 0,
                })
            }

            successful.push(tx.hash)
        }

        return { successful, failed, sideEffects, assignedTxs }
    }

    /**
     * Apply transactions in bulk and save the changes to the database.
     * Transactions touching disjoint entities are executed concurrently
     * (bounded by CONCURRENCY to protect the DB pool); transactions sharing
     * any entity are serialized within their group to preserve ordering.
     *
     * @param txs The transactions to apply
     * @param isRollback Whether the operation is a rollback
     *
     * @returns The successful and failed transactions (in original order)
     */
    static async applyTransactions(txs: Transaction[], isRollback: boolean) {
        log.debug("Applying GCR Edits for merged mempool (parallel groups)")
        const now = Date.now()

        const assignedTxsUpdates = new Map<string, AssignedTxRecord[]>()

        // filter out txs that don't mutate entities
        const toFilter = new Set<TransactionContent["type"]>([
            "web2Request",
            "storage",
            "escrow",
        ])
        let finalTxs = []

        for (const tx of txs) {
            if (toFilter.has(tx.content.type)) {
                // add the tx to the assignedTxsUpdates map
                const sender = normalizePubkey(
                    tx.content.from_ed25519_address || tx.content.from,
                )

                if (sender) {
                    const bucket = assignedTxsUpdates.get(sender) || []
                    bucket.push({
                        txHash: tx.hash,
                        blockNumber: tx.blockNumber ?? 0,
                    })
                    assignedTxsUpdates.set(sender, bucket)
                }
            } else {
                finalTxs.push(tx)
            }
        }

        log.debug(
            `[applyTransactions] Filtered ${txs.length} txs to ${finalTxs.length} txs`,
        )

        // AUDIT C5 — confirmed-tx-hash uniqueness (fork-gated, replay net).
        // The mempool/pre-merge filters drop already-confirmed hashes, but
        // those are read-before-mutate and can be raced or bypassed (e.g. a
        // tx injected straight onto the apply path). Re-query the confirmed
        // set HERE and drop any tx whose hash already sits in a confirmed
        // block, so a tx's balance edits can never be applied twice. Gated on
        // nonceEnforcement (same replay-protection fork, active @0 on fresh
        // chains): pre-fork the legacy behaviour is bit-identical for re-sync
        // safety. Skipped on rollback (rollback intentionally re-touches
        // confirmed txs). One batched query, not one per tx.
        if (
            !isRollback &&
            finalTxs.length > 0 &&
            isForkActive("nonceEnforcement", getSharedState.lastBlockNumber ?? 0)
        ) {
            const confirmed = await Chain.getExistingTransactionHashes(
                finalTxs.map(t => t.hash),
            )

            if (confirmed.size > 0) {
                log.error("Found confirmed txs during tx application")
                // fetch confirmed txs from db
                const confirmedTxs = await Chain.getTransactionsFromHashes(Array.from(confirmed))
                log.error("Confirmed txs: " + JSON.stringify(Array.from(confirmed), null, 2))
                log.error("Confirmed txs full: " + JSON.stringify(confirmedTxs.map(t => t.hash), null, 2))
                process.exit(1)

                const before = finalTxs.length
                finalTxs = finalTxs.filter(t => {
                    if (confirmed.has(t.hash)) {
                        log.warning(
                            `[applyTransactions] Dropping already-confirmed tx ${t.hash} (uniqueness guard)`,
                        )
                        return false
                    }
                    return true
                })
                log.debug(
                    `[applyTransactions] Uniqueness guard dropped ${before - finalTxs.length} confirmed tx(s)`,
                )
            }
        }

        const entities = await this.prepareEntities(finalTxs)
        const groups = this.partitionIndependentTxs(finalTxs)

        log.debug(
            `[applyTransactions] Partitioned ${finalTxs.length} txs into ${groups.length} independent groups`,
        )

        // Map from tx.hash to original index, used to restore side-effect
        // ordering across groups during merge.
        const txIndex = new Map<string, number>()
        for (let i = 0; i < finalTxs.length; i++)
            txIndex.set(finalTxs[i].hash, i)

        // Within a group, apply sequentially; across groups, apply in
        // parallel with bounded fan-out to protect the DB connection pool.
        // The ZK attestation handler opens its own queryRunner per tx.

        const CONCURRENCY = 8
        const groupResults: Awaited<ReturnType<typeof HandleGCR.runGroup>>[] =
            []
        for (let i = 0; i < groups.length; i += CONCURRENCY) {
            const slice = groups.slice(i, i + CONCURRENCY)
            const sliceResults = await Promise.all(
                slice.map(group =>
                    HandleGCR.runGroup(group, entities, isRollback, txIndex),
                ),
            )
            groupResults.push(...sliceResults)
        }

        // Merge group results. Senders only appear in one group (sender
        // pubkey unions all their txs), so assignedTxs keys are disjoint.
        const successfulSet = new Set<string>()
        const failedSet = new Set<string>()
        const allIndexedSideEffects: IndexedSideEffect[] = []

        for (const r of groupResults) {
            for (const h of r.successful) successfulSet.add(h)
            for (const h of r.failed) failedSet.add(h)
            allIndexedSideEffects.push(...r.sideEffects)
            for (const [sender, records] of r.assignedTxs) {
                const existing = assignedTxsUpdates.get(sender)
                if (existing) {
                    existing.push(...records)
                } else {
                    assignedTxsUpdates.set(sender, records)
                }
            }
        }

        // Restore original tx-order of side effects so downstream execution
        // matches the sequential baseline.
        allIndexedSideEffects.sort((a, b) => a.txIndex - b.txIndex)
        const mergedSideEffects = allIndexedSideEffects.map(s => s.fn)

        // Preserve original tx order in returned arrays.
        const successfulTxs: string[] = []
        const failedTxs: string[] = []
        for (const tx of finalTxs) {
            if (successfulSet.has(tx.hash)) successfulTxs.push(tx.hash)
            else if (failedSet.has(tx.hash)) failedTxs.push(tx.hash)
        }

        await HandleGCR.gcrWriteMutex.runExclusive(async () => {
            await this.saveGCREditChanges(entities, mergedSideEffects)
            if (assignedTxsUpdates.size > 0) {
                log.debug(
                    `[applyTransactions] Updating ${assignedTxsUpdates.size} assignedTxs`,
                )

                // TODO: Move this to after transactions have been saved to the database
                await this.bulkUpdateAssignedTxs(assignedTxsUpdates)
            }
        })

        const end = Date.now()
        log.only(
            `[applyTransactions] Time taken: ${(end - now) / 1000}s for ${finalTxs.length} txs across ${groups.length} groups (${txs.length - finalTxs.length} non-state-mutating skipped)`,
        )
        log.only(
            `[applyTransactions] Non-state-mutating skipped: ${txs.length - finalTxs.length}`,
        )
        log.only(`[applyTransactions] Total txs: ${txs.length}`)

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
        const now = Date.now()
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

        const end = Date.now()
        log.only(
            `[saveGCREditChanges] Time taken: ${(end - now) / 1000}s for ${sideEffects.length} side effects`,
        )
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
        if (isGCRMainEdit(editOperation)) {
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
            // KNOWN GAP: these branches persist via the default datasource
            // (not the transactionalEntityManager that wraps insertBlock),
            // so a partially-failed block leaves orphaned rows. Threading
            // the EM through HandleGCR + every routine is a separate
            // refactor — tracked in the upgradable-network testing doc.
            case "validatorStake":
                if (simulate) {
                    // Validation already ran during handleStakingTx; we don't
                    // mutate state during mempool simulation.
                    result = { success: true, message: "Simulated" }
                } else {
                    result = await GCRValidatorStakeRoutines.apply(editOperation)
                }
                break
            // Phase 1 governance: persists proposal/vote rows on every
            // node at block-confirmation time. Idempotent.
            case "networkUpgrade":
                if (simulate) {
                    result = { success: true, message: "Simulated" }
                } else {
                    const { default: GCRNetworkUpgradeRoutines } = await import(
                        "./gcr_routines/GCRNetworkUpgradeRoutines"
                    )
                    result = await GCRNetworkUpgradeRoutines.applyProposal(
                        editOperation,
                    )
                }
                break
            case "networkUpgradeVote":
                if (simulate) {
                    result = { success: true, message: "Simulated" }
                } else {
                    const { default: GCRNetworkUpgradeRoutines } = await import(
                        "./gcr_routines/GCRNetworkUpgradeRoutines"
                    )
                    result = await GCRNetworkUpgradeRoutines.applyVote(
                        editOperation,
                    )
                }
                break
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
}
