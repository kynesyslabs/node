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
import { maxRowsPerInsert } from "src/libs/blockchain/chainDb"
import Chain from "src/libs/blockchain/chain"
import { isForkActive } from "@/forks"
import {
    carriesGovernance,
    governanceGateRefusal,
} from "@/forks/governanceGate"
import { getSharedState } from "@/utilities/sharedState"
import { verifyGcrEditsMatch } from "src/libs/blockchain/validation/verifyGcrEdits"
import {
    derivedGasEdit,
    editBindingState,
    stakeSenderRefusal,
    verifyEditsAtApply,
    verifyNonceEditBinding,
} from "src/libs/blockchain/validation/editBinding"
import { debugAssertionsEnabled } from "src/libs/debug/nonceTrace"
import { generateFeeDistributionEdits } from "src/libs/blockchain/gcr/gcr_routines/feeDistribution"
import GCRBalanceRoutines from "./gcr_routines/GCRBalanceRoutines"
import GCRNonceRoutines from "./gcr_routines/GCRNonceRoutines"
import GCRValidatorStakeRoutines from "./gcr_routines/GCRValidatorStakeRoutines"

import {
    FindOperator,
    In,
    type EntityManager,
    type FindManyOptions,
    type Repository,
} from "typeorm"
import { Validators } from "@/model/entities/Validators"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import { gcrWriteMutex } from "./gcrWriteMutex"
import GCRIdentityRoutines from "./gcr_routines/GCRIdentityRoutines"
import { GCRTLSNotaryRoutines } from "./gcr_routines/GCRTLSNotaryRoutines"
import type {
    EditPlace,
    RemovedIdentities,
} from "./gcr_routines/routines/removedIdentities"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { GCRStorageProgramRoutines } from "./gcr_routines/GCRStorageProgramRoutines"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { storageProgramLeafHex } from "@/libs/blockchain/finality/storageRecord"
import { markStorageProgramsDirty } from "@/libs/blockchain/finality/storageRoot"
import { recordStorageHistory } from "@/libs/blockchain/finality/storageHistory"
import { Referrals } from "@/features/incentive/referrals"
// REVIEW: TLSNotary token management for native operations
import { createToken, extractDomain } from "@/features/tlsnotary/tokenManager"
import { INativePayload } from "@kynesyslabs/demosdk/types"
import {
    applyAllOrNothing,
    ATOMIC_ONLY_EDIT_TYPES,
    carriesWorkEdits,
    requiresAtomicApplication,
} from "@/libs/atomic-work/atomicApply"
import {
    settledEdits,
    splitSettlement,
} from "@/libs/atomic-work/feeAndNonce"
import { orderDeterministically } from "@/libs/consensus/v2/routines/deterministicOrder"
import {
    applyAtomicStoragePut,
    type StoragePutEdit,
} from "@/libs/blockchain/gcr/gcr_routines/GCRAtomicStorageRoutines"
import { StateReadError } from "@/libs/blockchain/gcr/stateReadError"
import {
    applySlotCas,
    applyWorkAttempt,
    sealWork,
    assertWorkEditSet,
    contendedWorkTxs,
    type SlotCasEdit,
    type SlotRecord,
    type WorkAttemptEdit,
    type WorkRecord,
} from "@/libs/atomic-work/workLedger"
import { DEFAULT_ATOMIC_WORK_LIMITS } from "@/libs/atomic-work/limits"
import {
    assertWorkEnvelope,
    ed25519SignerVerifier,
    type WorkEnvelope,
} from "@/libs/atomic-work/workEnvelope"
import {
    assertWithinWindow,
    executionClock,
    type ExecutionClock,
} from "@/libs/atomic-work/executionClock"
import { atomicWorkProfile } from "@/libs/atomic-work/profile"
import {
    buildWorkReceipt,
    type AppliedStorageWrite,
} from "@/libs/atomic-work/workReceipt"
import { GCRAtomicWork } from "@/model/entities/GCRv2/GCR_AtomicWork"

type AtomicWorkPayloadView = WorkEnvelope & { transfers?: { to?: unknown; amount?: unknown }[] }
import { GCRResourceSlot } from "@/model/entities/GCRv2/GCR_ResourceSlot"
import {
    type IndexedValues,
    indexedValues,
    unloadableEditKey,
    unstorableClaim,
    unstorableRow,
} from "./storableRows"
import { NOT_STORABLE, isKeyStorable } from "@/libs/blockchain/validation/postgresStorable"

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
    /** A database write that belongs in the transaction the edits commit in. */
    deferredWrite?: DeferredWrite
    response?: any
}

/** A write issued through the entity manager of the committing transaction. */
export type DeferredWrite = (em: EntityManager) => Promise<void>

export interface GCRTLSNotaryResult extends GCRResult {
    tlsNotary: GCRTLSNotary | null
}

export interface GCREntityCaches {
    accounts: Map<string, GCRMain>
    storagePrograms: Map<string, GCRStorageProgram | null>
    tlsNotaries: Map<string, GCRTLSNotary | null>
    atomicWorks: Map<string, WorkRecord | null>
    resourceSlots: Map<string, SlotRecord | null>
    /**
     * Validator rows read or written by this set, so a later stake edit in
     * the same block sees an earlier one. The rows themselves are written
     * as deferred writes.
     */
    validators?: Map<string, Validators | null>
    /** Proposal rows staged by this set, by proposal id. */
    networkUpgrades?: Map<string, NetworkUpgrade>
    /** Vote rows staged by this set, by proposal id and voter. */
    networkUpgradeVotes?: Map<string, NetworkUpgradeVote>
    /** ZK commitment hashes claimed by this set. */
    zkCommitments?: Map<string, true>
    /** ZK nullifiers claimed by this set. */
    zkNullifiers?: Map<string, true>
    /** What this set's identity unlinks removed, for their undo. */
    removedIdentities?: RemovedIdentities
}

/** The caches a set stages outside the entity maps, as one transaction saw them. */
type StagedSnapshot = Pick<
    GCREntityCaches,
    | "validators"
    | "networkUpgrades"
    | "networkUpgradeVotes"
    | "zkCommitments"
    | "zkNullifiers"
>

/** The key under which a vote row is staged. */
const voteKey = (row: { proposalId: string; voterAddress: string }) =>
    `${row.proposalId}:${row.voterAddress}`

/**
 * The partition key of an edit that reads or writes a staged cache. Every
 * edit on one cache shares a key, so they apply in block order and every
 * node resolves a conflict between them the same way.
 */
function stagedKeyOf(edit: GCREdit): "zk" | "validators" | "gov" | null {
    switch (edit.type as string) {
        case "identity": {
            const op = (edit as { operation?: string }).operation ?? ""
            return op.startsWith("zk_") ? "zk" : null
        }
        case "validatorStake":
            return "validators"
        case "networkUpgrade":
        case "networkUpgradeVote":
            return "gov"
        default:
            return null
    }
}

const STAGED_CACHES_BY_KEY: Record<"zk" | "validators" | "gov", (keyof StagedSnapshot)[]> = {
    zk: ["zkCommitments", "zkNullifiers"],
    validators: ["validators"],
    gov: ["networkUpgrades", "networkUpgradeVotes"],
}

/** The staged caches a transaction's edits read or write. */
function stagedCachesOf(edits: GCREdit[]): (keyof StagedSnapshot)[] {
    const names = new Set<keyof StagedSnapshot>()
    for (const edit of edits) {
        const key = stagedKeyOf(edit)
        if (key) for (const name of STAGED_CACHES_BY_KEY[key]) names.add(name)
    }
    return [...names]
}

/**
 * Copies of the staged caches a transaction's edits touch, to put back
 * when it fails. Only those: another group may be filling the rest.
 */
function snapshotStaged(
    entities: GCREntityCaches,
    edits: GCREdit[],
): Partial<StagedSnapshot> {
    const caches = entities as unknown as Record<string, Map<string, unknown> | undefined>
    const snapshot: Record<string, Map<string, unknown> | undefined> = {}
    for (const name of stagedCachesOf(edits)) {
        const cache = caches[name]
        snapshot[name] =
            cache &&
            new Map(
                [...cache].map(([k, v]) => [
                    k,
                    v && typeof v === "object" ? structuredClone(v) : v,
                ]),
            )
    }
    return snapshot as Partial<StagedSnapshot>
}

interface RowSnapshot {
    cache: Map<string, unknown>
    key: string
    present: boolean
    row: unknown
}

/** Copies of the storage program and proof rows a transaction's edits target. */
function snapshotRows(entities: GCREntityCaches, edits: GCREdit[]): RowSnapshot[] {
    const snapshots: RowSnapshot[] = []
    const seen = new Set<string>()
    const take = (cache: Map<string, unknown>, key: string, tag: string) => {
        if (seen.has(tag + key)) return
        seen.add(tag + key)
        const row = cache.get(key)
        snapshots.push({
            cache,
            key,
            present: cache.has(key),
            row: row && typeof row === "object" ? structuredClone(row) : row,
        })
    }
    for (const edit of edits) {
        if (edit.type === "storageProgram") {
            take(entities.storagePrograms, (edit as GCREditStorageProgram).target, "sp:")
        } else if (edit.type === "tlsnotary") {
            take(entities.tlsNotaries, (edit as GCREditTLSNotary).data.tokenId, "tls:")
        }
    }
    return snapshots
}

function restoreRows(snapshots: RowSnapshot[]) {
    for (const { cache, key, present, row } of snapshots) {
        if (present) cache.set(key, row)
        else cache.delete(key)
    }
}

function restoreStaged(entities: GCREntityCaches, snapshot: Partial<StagedSnapshot>) {
    const caches = entities as unknown as Record<string, unknown>
    for (const [name, copy] of Object.entries(snapshot)) caches[name] = copy
}

/**
 * A repository whose saves are collected instead of issued, for an edit
 * routine that writes its own table. The collected rows are written in the
 * block's transaction through the edit's `deferredWrite`. The row is copied
 * as saved, so a later edit that changes it and then fails leaves the write
 * as it was.
 */
function stagedRepository<T extends object>(
    repo: Repository<T>,
    staged: DeferredWrite[],
    onSaved?: (row: T) => void,
): Repository<T> {
    return new Proxy(repo, {
        get(target, property, receiver) {
            if (property === "save") {
                return async (row: T) => {
                    onSaved?.(row)
                    const saved = structuredClone(row)
                    staged.push(async em => {
                        await em.getRepository(target.target).save(saved)
                    })
                    return row
                }
            }
            const value = Reflect.get(target, property, receiver)
            return typeof value === "function" ? value.bind(target) : value
        },
    })
}

/** One deferred write that issues the staged saves in order. */
function deferredWriteOf(staged: DeferredWrite[]): DeferredWrite | undefined {
    if (staged.length === 0) return undefined
    return async em => {
        for (const write of staged) await write(em)
    }
}

/**
 * The block a transaction set is applied as part of. Its timestamp is the
 * consensus time a Work's deadlines are judged against: fixed before the
 * block's transactions are applied, and read back from the block by every
 * node that syncs it, so every node judges with the same value.
 */
export interface BlockClock {
    height: number
    /** Block timestamp, in seconds, as the block carries it. */
    timestampSec: number
}

export interface GCRApplyResult {
    success: boolean
    entities: GCREntityCaches
    message: string
    sideEffects: (() => Promise<void>)[]
    deferredWrites: DeferredWrite[]
    appliedEditsCount: number
    /** Failed in a block, and its nonce was spent anyway (`nonceIntegrity`). */
    nonceCharged?: boolean
    /** Failed in a block, and its fee was paid along with the nonce. */
    feeCharged?: boolean
    /**
     * Refused because its edits are not the ones its signed body implies:
     * what it would owe is unproven, so a failure charges nothing.
     */
    unproven?: boolean
}

export interface ApplyTransactionOptions {
    /**
     * Apply under the `nonceIntegrity` rules: the nonce must be the sender's
     * next one, and a failure still spends it. Set by the block apply only.
     */
    nonceRule?: boolean
    /** Amounts are OS units (`osDenomination`), for the gas a failure pays. */
    osAmounts?: boolean
}

/**
 * The outcome of applying a block's transactions, held in memory until the
 * block itself is inserted. `write` flushes it through the entity manager of
 * the block's transaction, so the state, its assignment stamps and the block
 * commit together or not at all. `afterCommit` runs the side effects that
 * follow from the state once it is durable.
 */
export interface PendingGCRWrite {
    entities: GCREntityCaches
    assignedTxs: Map<string, AssignedTxRecord[]>
    sideEffects: (() => Promise<void>)[]
    deferredWrites: DeferredWrite[]
    /** `block` is the block this state commits with; its storage undo log is written too. */
    write(em: EntityManager, block?: number): Promise<void>
    afterCommit(): Promise<void>
}

export interface ApplyTransactionsOptions {
    /**
     * Keep the result in memory and return it as `pending` instead of
     * committing it. The caller commits it with the block.
     */
    defer?: boolean
}

export interface ApplyTransactionsResult {
    successfulTxs: string[]
    failedTxs: string[]
    skippedTxs: string[]
    /** Set only when applied with `defer`. */
    pending?: PendingGCRWrite
    /**
     * Failed transactions whose nonce was spent, in block order. Set only
     * under `nonceIntegrity`.
     */
    nonceChargedTxs?: string[]
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

type IndexedDeferredWrite = {
    txIndex: number
    fn: DeferredWrite
}

/**
 * Epic #21 #204: derive the gasFeeSeparation fee-distribution edits for a tx
 * at APPLY time, from the SDK-shipped `transaction_fee`. Returns [] when the
 * fork is inactive, the tx is non-native, or no fee is owed. Pure +
 * deterministic across nodes (same shipped fee + same fee-distribution config
 * => same edits), so applied state never diverges. rpc_address is null at this
 * stage (rpc share folds to treasury); BFT-committed rpc routing is a
 * follow-up. Mirrors the pre-#204 prepend that confirmTransaction used to do,
 * moved here so the gossiped tx stays byte-identical to the signed one.
 */
function deriveFeeEditsForApply(tx: Transaction): GCREdit[] {
    if (tx.content?.type !== "native") return []
    if (!isForkActive("gasFeeSeparation", getSharedState.lastBlockNumber ?? 0)) {
        return []
    }
    const fee = tx.content.transaction_fee
    if (!fee) return []
    const senderAddress =
        typeof tx.content.from === "string"
            ? tx.content.from
            : forgeToHex(tx.content.from as never)
    // Derive the fee edits from the SDK-shipped transaction_fee — the SAME
    // source verifyGcrEditsMatch regenerates from at apply, so the injected
    // edits and the binding check agree. (Number() handles the OS-string wire
    // shape: "1000000000" -> 1000000000.) The shipped fee was already bound to
    // the node's computed total at ingress (applyGasFeeSeparation), so a forged
    // / underpaid fee cannot reach here. rpc_address is null at the RC stage ->
    // the rpc share folds to treasury deterministically (BFT-committed rpc
    // routing is the mainnet follow-up).
    return generateFeeDistributionEdits({
        senderAddress,
        rpcAddress: fee.rpc_address ?? null,
        networkFee: Number(fee.network_fee),
        rpcFee: Number(fee.rpc_fee),
        additionalFee: Number(fee.additional_fee),
        txHash: tx.hash ?? "",
        isRollback: false,
    }) as GCREdit[]
}

function sameFeeEdit(a: GCREdit, b: GCREdit): boolean {
    if (a.type !== "balance" || b.type !== "balance") return false
    return (
        a.operation === b.operation &&
        normalizePubkey(a.account) === normalizePubkey(b.account) &&
        String(a.amount) === String(b.amount)
    )
}

/**
 * The tx with its fee edits in front, without touching the tx passed in.
 *
 * A tx that already starts with exactly those edits is returned as is: rows
 * stored before the fee edits were kept off the persisted tx still carry
 * them, and peers serve those rows during sync.
 */
export function withDerivedFeeEdits(tx: Transaction): Transaction {
    const feeEdits = deriveFeeEditsForApply(tx)
    if (feeEdits.length === 0) return tx

    const edits = tx.content.gcr_edits ?? []
    const alreadyCarried =
        edits.length >= feeEdits.length &&
        feeEdits.every((fee, i) => sameFeeEdit(fee, edits[i]))
    if (alreadyCarried) return tx

    // The edits are copied too, not just the array: apply writes into each
    // edit (its txhash), and those objects belong to the signed tx.
    return Object.assign(Object.create(Object.getPrototypeOf(tx)), tx, {
        content: {
            ...tx.content,
            gcr_edits: [...feeEdits, ...edits.map(edit => structuredClone(edit))],
        },
    }) as Transaction
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

/** Rows of one cache an edit can write: those under `keys`, or all of them. */
type WrittenRows = { cache: string; rows: Map<unknown, unknown> | undefined; keys: unknown[] | "all" }

/** Rows each written row held before the edit, by cache and then by key. */
type StoredIndexes = Map<string, Map<unknown, IndexedValues | undefined>>

/**
 * The rows `edit` can write, which are the rows it is judged on. Only rows
 * the edit's own group can write are named: groups apply concurrently over
 * the same caches, so another group's row may hold a value it has not yet
 * put back, and reading it would make the verdict depend on scheduling. An
 * identity edit writes its account's cached row alone (other accounts it
 * credits are not in the caches).
 */
function rowsEditWrites(edit: GCREdit, entities: GCREntityCaches): WrittenRows[] {
    const fields = edit as unknown as Record<string, any>
    const caches = entities as unknown as Record<string, Map<unknown, unknown> | undefined>
    const one = (cache: string, key: unknown): WrittenRows[] => [{ cache, rows: caches[cache], keys: [key] }]
    const all = (cache: string): WrittenRows => ({ cache, rows: caches[cache], keys: "all" })
    switch (edit.type as string) {
        case "identity":
            return one("accounts", normalizePubkey(fields.account))
        case "storageProgram":
        case "storage-program-put":
            return one("storagePrograms", fields.target)
        case "tlsnotary":
            return one("tlsNotaries", fields.data?.tokenId)
        case "work-attempt":
            return one("atomicWorks", fields.workId)
        case "resource-slot-cas":
            return one("resourceSlots", fields.resourceKey)
        case "validatorStake":
            return [all("validators")]
        case "networkUpgrade":
        case "networkUpgradeVote":
            return [all("networkUpgrades"), all("networkUpgradeVotes")]
        default:
            return []
    }
}

function writtenEntries(written: WrittenRows): [unknown, unknown][] {
    if (!written.rows) return []
    if (written.keys === "all") return [...written.rows.entries()]
    return written.keys.map(key => [key, written.rows!.get(key)])
}

/** The indexed values of the rows `edit` can write, as they are before it applies. */
function storedIndexes(edit: GCREdit, entities: GCREntityCaches): StoredIndexes {
    const stored: StoredIndexes = new Map()
    for (const written of rowsEditWrites(edit, entities)) {
        const byKey = new Map<unknown, IndexedValues | undefined>()
        for (const [key, row] of writtenEntries(written)) byKey.set(key, indexedValues(written.cache, row))
        stored.set(written.cache, byKey)
    }
    return stored
}

/**
 * Where a row `edit` has just written cannot be stored, as "cache.column",
 * or null. Judged on the rows rather than the edit, so only what a routine
 * really stores counts. Balance and nonce edits store numbers, under a key
 * nothing checks for shape: a native send credits whatever its body names.
 * The ZK claims are written only by zk edits, which all apply in one group.
 * `stored` is what `storedIndexes` read before the edit applied.
 */
function unstorableAfter(edit: GCREdit, entities: GCREntityCaches, stored: StoredIndexes): string | null {
    const fields = edit as unknown as Record<string, any>
    switch (edit.type as string) {
        case "balance":
        case "nonce":
            return isKeyStorable(normalizePubkey(fields.account)) ? null : "accounts.pubkey"
    }
    for (const written of rowsEditWrites(edit, entities)) {
        for (const [key, row] of writtenEntries(written)) {
            const where = unstorableRow(written.cache, row, stored.get(written.cache)?.get(key))
            if (where) return where
        }
    }
    if (edit.type === "identity" && stagedKeyOf(edit) === "zk") {
        return (
            unstorableClaim("zkCommitments", entities.zkCommitments) ??
            unstorableClaim("zkNullifiers", entities.zkNullifiers)
        )
    }
    return null
}

/**
 * Why `pubkey` cannot be the key HandleGCR.createAccount builds an account
 * under, or null. Kept in step with it by a test: the referral code it
 * derives needs 64 characters after an optional 0x. Rows the chain creates
 * all have that shape; a restored snapshot is not held to it.
 */
export function uncreatableAccountKey(pubkey: unknown): string | null {
    if (typeof pubkey !== "string" || pubkey.trim().length === 0) return "not a public key"
    const bare = pubkey.startsWith("0x") ? pubkey.slice(2) : pubkey
    return bare.length === 64 ? null : "not 64 characters after 0x"
}

const NO_KEYS: ReadonlySet<string> = new Set()

/**
 * Why an edit's account cannot be loaded, as prepareEntities loads it, or
 * null. Every account key must normalize to a storable key. One that is
 * `loaded` and not among the `stored` rows is created, so it must also be
 * creatable; one that is only grouped by never is.
 */
function accountKeyProblem(
    account: unknown,
    loaded: boolean,
    stored: ReadonlySet<string> = NO_KEYS,
): string | null {
    let pubkey: string
    try {
        pubkey = normalizePubkey(account as string)
    } catch {
        return "not a public key"
    }
    if (typeof pubkey !== "string") return "not a public key"
    if (!isKeyStorable(pubkey)) return NOT_STORABLE
    return loaded && !stored.has(pubkey) ? uncreatableAccountKey(pubkey) : null
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
    static gcrWriteMutex = gcrWriteMutex

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
        manager?: EntityManager,
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

        const repo = (manager ?? dataSource).getRepository(GCRAssignedTx)
        const chunkSize = maxRowsPerInsert(repo, GCRAssignedTx)
        for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize)
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
    /**
     * The edit to apply, carrying the transaction hash. The edits are part of
     * the signed content, which is stored and served to syncing peers as is:
     * stamping them, or letting a routine keep a reference into them, changes
     * the content so that it no longer hashes to tx.hash, and every peer
     * syncing that block rejects it.
     */
    /**
     * The place of each of the transaction's edits on a block apply; none on
     * a simulation, whose admission must not write undo records.
     */
    static editPlaces(
        entities: GCREntityCaches,
        tx: Transaction,
        simulate: boolean,
    ): (edit: GCREdit) => EditPlace | undefined {
        if (simulate || !tx.hash) return () => undefined
        const removed = (entities.removedIdentities ??= new Map())
        const signed = tx.content.gcr_edits ?? []
        return edit => {
            const position = signed.indexOf(edit)
            return position === -1
                ? undefined
                : { txhash: tx.hash, position, removed }
        }
    }

    static stampedEdit(edit: GCREdit, tx: Transaction, simulate: boolean): GCREdit {
        if (simulate || !tx.hash) return edit
        const copy = structuredClone(edit)
        copy.txhash = tx.hash
        return copy
    }

    static async prepareEntities(txs: Transaction[]): Promise<GCREntityCaches> {
        const affectedPubkeys = new Set<string>()
        const affectedStorageAddresses = new Set<string>()
        const affectedTokenIds = new Set<string>()
        const affectedWorkIds = new Set<string>()
        const affectedSlotKeys = new Set<string>()

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
                } else if (
                    (editType as string) === "work-attempt" ||
                    (editType as string) === "work-receipt"
                ) {
                    affectedWorkIds.add(
                        (edit as unknown as { workId: string }).workId,
                    )
                } else if ((editType as string) === "storage-program-put") {
                    affectedStorageAddresses.add(
                        (edit as unknown as { target: string }).target,
                    )
                } else if ((editType as string) === "resource-slot-cas") {
                    affectedSlotKeys.add(
                        (edit as unknown as { resourceKey: string })
                            .resourceKey,
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
        const [
            gcrMainCache,
            storageProgramCache,
            tlsNotaryCache,
            atomicWorkCache,
            resourceSlotCache,
        ] = await Promise.all([
            this.loadGCRMainEntities(affectedPubkeys),
            this.loadStorageProgramEntities(affectedStorageAddresses),
            this.loadTLSNotaryEntities(affectedTokenIds),
            this.loadAtomicWorks(affectedWorkIds),
            this.loadResourceSlots(affectedSlotKeys),
        ])

        return {
            accounts: gcrMainCache,
            storagePrograms: storageProgramCache,
            tlsNotaries: tlsNotaryCache,
            atomicWorks: atomicWorkCache,
            resourceSlots: resourceSlotCache,
        }
    }

    // Missing rows stay absent: an absent Work has not run, an absent slot is
    // vacant. Rows are copied into plain records so the edit handlers never
    // hold an entity instance.
    private static async loadAtomicWorks(
        workIds: Set<string>,
    ): Promise<Map<string, WorkRecord | null>> {
        const cache = new Map<string, WorkRecord | null>()
        if (workIds.size === 0) return cache
        const rows = await dataSource
            .getRepository(GCRAtomicWork)
            .find({ where: { workId: In([...workIds]) } })
        for (const row of rows) cache.set(row.workId, { ...row })
        return cache
    }

    private static async loadResourceSlots(
        keys: Set<string>,
    ): Promise<Map<string, SlotRecord | null>> {
        const cache = new Map<string, SlotRecord | null>()
        if (keys.size === 0) return cache
        const rows = await dataSource
            .getRepository(GCRResourceSlot)
            .find({ where: { resourceKey: In([...keys]) } })
        for (const row of rows) cache.set(row.resourceKey, row.record)
        return cache
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
     * @param clock - The block being applied, when there is one
     **/
    static async applyTransaction(
        entities: GCREntityCaches,
        tx: Transaction,
        isRollback: boolean,
        simulate: boolean,
        clock?: BlockClock,
        options: ApplyTransactionOptions = {},
    ): Promise<GCRApplyResult> {
        const nonceEdit =
            options.nonceRule && !simulate && !isRollback
                ? (tx.content.gcr_edits ?? []).find(
                      (e): e is GCREditNonce => e.type === "nonce",
                  )
                : undefined
        // A transaction without one was checked to spend no nonce before
        // apply was reached.
        if (!nonceEdit) {
            return this.applyTransactionEdits(entities, tx, isRollback, simulate, clock)
        }

        // Read on the state the earlier transactions of the block left, the
        // same on every node, unlike the pool's projection.
        const account = entities.accounts.get(normalizePubkey(nonceEdit.account))
        const expected = (account?.nonce ?? 0) + 1
        if (!account || tx.content.nonce !== expected) {
            const message = account
                ? `Nonce mismatch: expected ${expected}, got ${tx.content.nonce}`
                : "Missing account for nonce edit"
            log.error(`[applyTransaction] Refusing tx ${tx.hash}: ${message}`)
            return {
                success: false,
                entities,
                message,
                sideEffects: [],
                deferredWrites: [],
                appliedEditsCount: 0,
            }
        }

        // Taken before apply: a failure reverses the applied edits in place,
        // and its snapshot restore followed by that reversal can leave a
        // balance edit undone twice.
        const before = HandleGCR.snapshotAccounts(entities, tx)
        const fee = await HandleGCR.failureFee(tx, nonceEdit, !!options.osAmounts)
        const nonceCharge = structuredClone(nonceEdit)

        const result = await this.applyTransactionEdits(
            entities,
            tx,
            isRollback,
            simulate,
            clock,
        )
        if (result.success || result.unproven) return result

        // Executed in a block and failed: the effects are gone, but the fee
        // and the nonce are spent. A free failure would be an unlimited
        // retry, and an unspent nonce could be signed again for another
        // transaction while a later nonce of this block did apply.
        for (const [pubkey, entity] of before) {
            entities.accounts.set(
                pubkey,
                entity ?? (await HandleGCR.createAccount(pubkey, {}, true)),
            )
        }
        const charged = await HandleGCR.chargeFailure(
            entities,
            tx.hash,
            fee,
            nonceCharge,
            expected,
        )
        if (!charged.nonceCharged) {
            log.error(
                `[applyTransaction] Failed tx ${tx.hash} could not be charged its nonce`,
            )
        }
        return { ...result, ...charged }
    }

    /**
     * Copies of the accounts a transaction's edits name, as they are now;
     * null for an account the caches do not hold yet.
     */
    private static snapshotAccounts(
        entities: GCREntityCaches,
        tx: Transaction,
    ): Map<string, GCRMain | null> {
        const before = new Map<string, GCRMain | null>()
        for (const edit of tx.content.gcr_edits ?? []) {
            if (!isGCRMainEdit(edit)) continue
            const pubkey = normalizePubkey(edit.account)
            if (before.has(pubkey)) continue
            const entity = entities.accounts.get(pubkey)
            before.set(pubkey, entity ? structuredClone(entity) : null)
        }
        return before
    }

    /**
     * What a transaction that fails in a block pays: the fee edits derived
     * for it at apply, then the gas every SDK builder charges, derived here
     * rather than read from the shipped edits, which a sender could leave
     * the gas out of while editBinding is dormant. Identity and d402
     * transactions pay no gas, and a Work replay pays nothing because the
     * Work it reads back already paid. A type's own debits (a storage burn,
     * a stake) are never charged.
     *
     * Copied, because a failed apply reverses the edits it ran in place.
     */
    private static async failureFee(
        tx: Transaction,
        nonceEdit: GCREditNonce,
        osAmounts: boolean,
    ): Promise<GCREdit[]> {
        const edits = tx.content.gcr_edits ?? []
        const isReplay = edits.some(
            e =>
                (e.type as string) === "work-attempt" &&
                (e as unknown as WorkAttemptEdit).attemptClass === "replay",
        )
        if (isReplay) return []

        const fee: GCREdit[] = []
        const derived = deriveFeeEditsForApply(tx)
        const carriesDerived =
            derived.length > 0 &&
            edits.length >= derived.length &&
            derived.every((d, i) => sameFeeEdit(d, edits[i]))
        if (carriesDerived) fee.push(...edits.slice(0, derived.length))

        const gas = await derivedGasEdit(
            tx.content.type as string,
            normalizePubkey(nonceEdit.account),
            osAmounts,
        )
        if (gas) fee.push(gas)
        return fee.map(e => structuredClone(e))
    }

    /**
     * Charges a failed transaction on the state from before it: its fee and
     * nonce together, or the nonce alone when the fee cannot be paid, so the
     * account always moves past the nonce. A balance that cannot cover the
     * fee is judged on that state, the same on every node.
     */
    private static async chargeFailure(
        entities: GCREntityCaches,
        txhash: string,
        fee: GCREdit[],
        nonceEdit: GCREditNonce,
        expected: number,
    ): Promise<{ nonceCharged: boolean; feeCharged: boolean }> {
        const account = entities.accounts.get(normalizePubkey(nonceEdit.account))
        if (account?.nonce !== expected - 1) {
            return { nonceCharged: false, feeCharged: false }
        }
        const applyOne = (edit: GCREdit, caches: GCREntityCaches) =>
            HandleGCR.applyGCREdit(
                { ...structuredClone(edit), isRollback: false, txhash },
                caches,
                false,
                false,
            )
        if (fee.length > 0) {
            const both = await applyAllOrNothing(
                entities,
                [...fee, nonceEdit],
                applyOne,
            )
            if (both.success) return { nonceCharged: true, feeCharged: true }
            log.warning(
                `[applyTransaction] Failed tx ${txhash} cannot pay its fee: ${both.message}; charging the nonce only`,
            )
        }
        const nonceOnly = await applyAllOrNothing(entities, [nonceEdit], applyOne)
        return { nonceCharged: nonceOnly.success, feeCharged: false }
    }

    private static async applyTransactionEdits(
        entities: GCREntityCaches,
        tx: Transaction,
        isRollback: boolean,
        simulate: boolean,
        clock?: BlockClock,
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
                deferredWrites: [],
                appliedEditsCount: 0,
            }
        }

        // A block refuses these in its pre-pass; this also covers the callers
        // that apply one transaction directly (simulation, L2PS proofs).
        if (!isRollback && carriesGovernance(tx)) {
            const refusal = governanceGateRefusal(
                tx,
                (await editBindingState()).governance,
            )
            if (refusal) {
                log.error(`[applyTransaction] Refusing tx ${tx.hash}: ${refusal}`)
                return {
                    success: false,
                    entities,
                    message: refusal,
                    sideEffects: [],
                    deferredWrites: [],
                    appliedEditsCount: 0,
                    unproven: true,
                }
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
            (tx.content.type === "native" || carriesWorkEdits(tx)) &&
            isForkActive(
                "nonceEnforcement",
                getSharedState.lastBlockNumber ?? 0,
            )
        ) {
            // Epic #21 #204: by the time apply runs, applyTransactions has
            // prepended the derived fee edits onto tx.content.gcr_edits (when
            // gasFeeSeparation is active), so the shipped set DOES carry fee
            // edits here — the binding regen must reproduce them too.
            // expectFeeEdits mirrors the fork, matching the derive step.
            const expectFeeEdits = isForkActive(
                "gasFeeSeparation",
                getSharedState.lastBlockNumber ?? 0,
            )
            // Once editBinding binds the set at admission and in the apply
            // pre-pass, this check only has to agree with that comparison, which
            // ignores the order of an edit's keys.
            const { match } = await verifyGcrEditsMatch(tx, {
                expectFeeEdits,
                keyOrderInsensitive: (await editBindingState()).active,
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
                    deferredWrites: [],
                    appliedEditsCount: 0,
                    unproven: true,
                }
            }
        }

        const gcrEdits = [...tx.content.gcr_edits]

        // INFO: Reverse order of gcr_edits for rollback
        if (isRollback) {
            gcrEdits.reverse()
        }

        // A Work's edits never go through apply-then-reverse: the reversal
        // leaves intermediate state visible and can itself fail halfway.
        if (requiresAtomicApplication(gcrEdits)) {
            const refusal = (message: string): GCRApplyResult => {
                log.error(
                    `[applyTransaction] Work tx ${tx.hash} not applied: ${message}`,
                )
                return {
                    success: false,
                    entities,
                    message,
                    sideEffects: [],
                    deferredWrites: [],
                    appliedEditsCount: 0,
                }
            }
            if (
                !isForkActive("atomicWork", getSharedState.lastBlockNumber ?? 0)
            ) {
                return refusal("Work edits are not active at this height")
            }
            // Built and sealed after every edit passed, in the same transition.
            let seal: ((caches: GCREntityCaches) => GCRResult) | undefined
            const payload = (tx.content.data as unknown as [string, AtomicWorkPayloadView] | undefined)?.[1]
            // In signed order: rollback reverses its own copy of the edits.
            const parts = splitSettlement(
                tx.content.gcr_edits,
                ATOMIC_ONLY_EDIT_TYPES,
                payload?.transfers?.length ?? 0,
            )
            const attempt = tx.content.gcr_edits.find(
                e => (e.type as string) === "work-attempt",
            ) as unknown as WorkAttemptEdit | undefined
            const isReplay = attempt?.attemptClass === "replay"
            // Rollback replays edits the block already accepted, reversed.
            if (!isRollback) {
                // Work edits are bound to an authorized intent, which only
                // an atomicWork transaction carries.
                if ((tx.content.type as string) !== "atomicWork") {
                    return refusal("Work edits travel only in an atomicWork transaction")
                }
                const envelope = assertWorkEnvelope(
                    payload,
                    gcrEdits as never,
                    payload?.transfers?.length ?? 0,
                    DEFAULT_ATOMIC_WORK_LIMITS,
                    ed25519SignerVerifier,
                    normalizePubkey(
                        tx.content.from_ed25519_address || tx.content.from,
                    ),
                )
                if (!envelope.success) return refusal(envelope.message)
                const shape = assertWorkEditSet(
                    gcrEdits,
                    normalizePubkey(
                        tx.content.from_ed25519_address || tx.content.from,
                    ),
                )
                if (!shape.success) return refusal(shape.message)

                // Deadlines are judged against consensus time only. A
                // simulation has no block yet, so it uses the last block's
                // time: a Work already expired then cannot become valid.
                let workClock: ExecutionClock
                try {
                    if (clock) {
                        workClock = executionClock(
                            clock.height,
                            clock.timestampSec * 1000,
                        )
                    } else if (simulate) {
                        const last = getSharedState.lastBlockNumber ?? 0
                        const lastBlock = await Chain.getBlockByNumber(last)
                        workClock = executionClock(
                            last,
                            Number(lastBlock?.content?.timestamp ?? 0) * 1000 || 1,
                        )
                    } else {
                        return refusal(
                            "a Work cannot execute without the consensus block time",
                        )
                    }
                    // A replay only reads back a Work that already ran, so
                    // the original deadline does not apply to it. Admission
                    // judges only the deadline: notBefore is checked against
                    // the block the Work lands in, which may be the first
                    // one late enough, not against the block before it.
                    if (!isReplay) {
                        assertWithinWindow(workClock, {
                            notBeforeMs: simulate && !clock
                                ? null
                                : (payload.intent.notBefore as number | null),
                            deadlineMs: payload.intent.expiresAt as number | null,
                        }, "this Work")
                    }
                } catch (error) {
                    return refusal(
                        error instanceof Error ? error.message : String(error),
                    )
                }

                if (!isReplay) {
                    const profile = atomicWorkProfile(
                        payload.intent.profile as string,
                    )
                    const writes = gcrEdits
                        .filter(e => (e.type as string) === "storage-program-put")
                        .map(e => e as unknown as AppliedStorageWrite)
                    const slotEdits = gcrEdits
                        .filter(e => (e.type as string) === "resource-slot-cas")
                        .map(e => e as unknown as SlotCasEdit)
                    const slotKeys = slotEdits.map(e => e.resourceKey)
                    const sender = normalizePubkey(
                        tx.content.from_ed25519_address || tx.content.from,
                    )
                    const transfers = (payload.transfers ?? []).map(t => ({
                        from: sender,
                        to: String(t.to),
                        amount: String(t.amount),
                    }))
                    seal = caches => {
                        // Read after every edit applied: the state each slot
                        // was left in is part of what the receipt commits to.
                        const slots = slotEdits.map(e => {
                            const after = caches.resourceSlots.get(e.resourceKey) as
                                | { state: string; generation: number; workId: string; conflictDigest: string }
                                | null
                                | undefined
                            return {
                                resourceKey: e.resourceKey,
                                before: { state: e.expected.state, generation: e.expected.generation },
                                after: {
                                    state: after?.state ?? "unknown",
                                    generation: after?.generation ?? -1,
                                    workId: after?.workId ?? "",
                                    conflictDigest: after?.conflictDigest ?? "",
                                },
                            }
                        })
                        const built = buildWorkReceipt({
                            intent: payload.intent,
                            profile,
                            workId: attempt.workId,
                            attemptId: attempt.attemptId,
                            txHash: tx.hash ?? "",
                            // The block being built (consensus) or the block
                            // being synced: the same number on every node.
                            height:
                                tx.blockNumber ??
                                (getSharedState.lastBlockNumber ?? 0) + 1,
                            nonce: tx.content.nonce,
                            writes,
                            slots,
                            transfers,
                            timestampMs: clock ? clock.timestampSec * 1000 : undefined,
                        })
                        return sealWork(
                            attempt.workId,
                            built.receipt,
                            built.receiptCommitment,
                            built.operationReceiptRoot,
                            slotKeys,
                            caches.atomicWorks,
                            caches.resourceSlots,
                        )
                    }
                }
            }
            const applyOne = (edit: GCREdit, caches: GCREntityCaches) =>
                HandleGCR.applyStorableEdit(
                    HandleGCR.stampedEdit(edit, tx, simulate),
                    caches,
                    isRollback,
                    simulate,
                )
            const inOrder = (edits: GCREdit[]) =>
                isRollback ? [...edits].reverse() : edits
            const done = (
                r: Awaited<ReturnType<typeof applyAllOrNothing>>,
                message = r.message,
            ): GCRApplyResult => ({
                success: r.success,
                entities,
                message,
                sideEffects: r.sideEffects,
                deferredWrites: [],
                appliedEditsCount: r.appliedEditsCount,
            })

            // What a block applied for this Work decides what its rollback
            // undoes: the whole Work if it is the recorded winner, otherwise
            // only the fee and nonce it was charged when it rolled back.
            if (isRollback) {
                const record = attempt
                    ? entities.atomicWorks.get(attempt.workId)
                    : null
                const committed =
                    !isReplay &&
                    record?.winnerAttemptId === attempt?.attemptId &&
                    record?.txHash === tx.hash
                const outcome = isReplay
                    ? "replayed"
                    : committed
                      ? "committed"
                      : "rolled-back"
                return done(
                    await applyAllOrNothing(
                        entities,
                        inOrder(settledEdits(parts, outcome, outcome !== "rolled-back")),
                        applyOne,
                    ),
                )
            }

            const result = await applyAllOrNothing(
                entities,
                settledEdits(parts, isReplay ? "replayed" : "committed", true),
                applyOne,
                seal && (caches => {
                    const sealed = seal(caches)
                    if (!sealed.success) return sealed
                    // The receipt quotes the Work's payload into jsonb.
                    const where = unstorableRow(
                        "atomicWorks",
                        attempt ? caches.atomicWorks.get(attempt.workId) : null,
                    )
                    return where === null
                        ? sealed
                        : { success: false, message: `${where} holds a value Postgres cannot store` }
                }),
            )
            if (result.success || simulate || isReplay) {
                if (!result.success) {
                    log.error(
                        `[applyTransaction] Work tx ${tx.hash} not applied (edit ${result.failedAt}): ${result.message}`,
                    )
                }
                return done(result)
            }

            // Executed in a block and failed: its effects are gone, but the
            // execution cost what a success would, so the fee and nonce are
            // spent. Free failure would be an unlimited retry. Every node
            // reruns the same Work on the same state, so all charge alike.
            const charged = await applyAllOrNothing(
                entities,
                settledEdits(parts, "rolled-back", false),
                applyOne,
            )
            log.warning(
                `[applyTransaction] Work tx ${tx.hash} rolled back (edit ${result.failedAt}): ${result.message}` +
                    (charged.success ? "; fee and nonce charged" : `; could not charge: ${charged.message}`),
            )
            return charged.success
                ? done(charged, `Work rolled back: ${result.message}`)
                : done(result)
        }

        // Capture snapshots for potential rollback
        const snapshots: GCRMainSnapshot[] = []
        const staged = snapshotStaged(entities, gcrEdits)
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
        // A storage or proof row an edit wrote must not outlive a later edit
        // of the same transaction that fails: the fee and nonce are put
        // back, so the write would be free.
        const rowSnapshots = snapshotRows(entities, gcrEdits)
        const sideEffects: (() => Promise<void>)[] = []
        const deferredWrites: DeferredWrite[] = []
        const appliedEdits: GCREdit[] = []
        const appliedPlaces: (EditPlace | undefined)[] = []
        const placeOf = HandleGCR.editPlaces(entities, tx, simulate)

        // Apply all edits for this tx
        for (const signedEdit of gcrEdits) {
            const edit = HandleGCR.stampedEdit(signedEdit, tx, simulate)
            const place = placeOf(signedEdit)

            let result: GCRResult

            try {
                result = await HandleGCR.applyStorableEdit(
                    edit,
                    entities,
                    isRollback,
                    simulate,
                    place,
                )
            } catch (error) {
                if (error instanceof StateReadError) throw error
                log.error(`[applyTransaction] Error applying GCREdit: ${error}`)
                result = {
                    success: false,
                    message: `Error applying GCREdit: ${error}`,
                }
            }

            if (!result.success) {
                // INFO: If on a serious run, rollback hard edits
                if (!simulate && !this.GCRTxTypes.has(edit.type)) {
                    await this.rollback(tx, entities, appliedEdits, appliedPlaces)
                }
                // After the rollback, which also reverses the balance edits:
                // reversing them on the restored accounts would refund them twice.
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
                restoreRows(rowSnapshots)
                // After the rollback, which may have edited the staged rows
                restoreStaged(entities, staged)

                return {
                    success: false,
                    entities,
                    message: result.message,
                    sideEffects: [],
                    deferredWrites: [],
                    appliedEditsCount: 0,
                }
            }

            if (result.sideEffect) {
                sideEffects.push(result.sideEffect)
            }
            if (result.deferredWrite) {
                deferredWrites.push(result.deferredWrite)
            }

            appliedEdits.push(edit)
            appliedPlaces.push(place)
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
            deferredWrites: deferredWrites,
            appliedEditsCount: appliedEdits.length,
        }
    }

    /**
     * The transactions of a block that lose to an earlier one over the same
     * Work, slot or storage address. Earlier is the canonical order, so every
     * node picks the same winners whatever order it received the block in.
     */
    static contendedInBlock<T extends Transaction>(txs: T[]): Set<string> {
        return contendedWorkTxs(orderDeterministically(txs))
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
                    } else if (
                        // Compared as a string: these kinds are newer than
                        // some SDK builds' edit union.
                        (edit.type as string) === "storage-program-put"
                    ) {
                        keys.push(
                            "sp:" +
                                (edit as unknown as { target: string }).target,
                        )
                    } else if ((edit.type as string) === "resource-slot-cas") {
                        // Two Works contending for one slot must be applied
                        // in order, never in concurrent groups.
                        keys.push(
                            "slot:" +
                                (edit as unknown as { resourceKey: string })
                                    .resourceKey,
                        )
                    } else if (
                        (edit.type as string) === "work-attempt" ||
                        (edit.type as string) === "work-receipt"
                    ) {
                        keys.push(
                            "work:" +
                                (edit as unknown as { workId: string }).workId,
                        )
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
                    // A stake moves the balance of the account it names.
                    if ((edit.type as string) === "validatorStake") {
                        const stakeAccount = (
                            edit as unknown as { account?: string | Uint8Array }
                        ).account
                        if (stakeAccount) {
                            keys.push("acc:" + normalizePubkey(stakeAccount))
                        }
                    }
                    const stagedKey = stagedKeyOf(edit)
                    if (stagedKey) keys.push(stagedKey)
                    // A proposal reads the proposer's validator row as
                    // the stake edits before it in the block left it.
                    if ((edit.type as string) === "networkUpgrade") {
                        keys.push("validators")
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
        clock?: BlockClock,
        nonceRule = false,
        osAmounts = false,
    ) {
        const successful: string[] = []
        const failed: string[] = []
        const nonceCharged: string[] = []
        const sideEffects: IndexedSideEffect[] = []
        const deferredWrites: IndexedDeferredWrite[] = []
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
                clock,
                nonceRule ? { nonceRule, osAmounts } : undefined,
            )
            const assign = () => {
                const sender = normalizePubkey(
                    tx.content?.from_ed25519_address || tx.content.from,
                )
                if (!sender || !tx.hash) return
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

            if (!applyResult.success) {
                failed.push(tx.hash)
                // A charged failure changed the sender's account, so it is
                // part of that account's history like a success.
                if (applyResult.nonceCharged) {
                    nonceCharged.push(tx.hash)
                    assign()
                }
                continue
            }

            const idx = txIndex.get(tx.hash)
            for (const fn of applyResult.sideEffects) {
                sideEffects.push({ txIndex: idx, fn })
            }
            for (const fn of applyResult.deferredWrites) {
                deferredWrites.push({ txIndex: idx, fn })
            }

            assign()
            successful.push(tx.hash)
        }

        return {
            successful,
            failed,
            nonceCharged,
            sideEffects,
            deferredWrites,
            assignedTxs,
        }
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
    /** Delete gcr_assigned_txs rows stamped with `blockNumber`. */
    static async deleteAssignedTxsForBlock(
        blockNumber: number,
        manager?: EntityManager,
    ): Promise<number> {
        const source = manager ?? (await Datasource.getInstance()).getDataSource()
        const res = await source
            .getRepository(GCRAssignedTx)
            .delete({ blockNumber })
        return res.affected ?? 0
    }

    /**
     * The transactions of a block refused before apply: those the
     * `networkGovernance` rule refuses, whether or not `editBinding` is
     * active, and those whose shipped edits are not the ones their signed
     * body implies (`editBinding` fork). Apply runs the shipped edits as they
     * are, so a block must never reach it with edits nobody derived.
     *
     * Judged on the transactions as received, before the node derives fee
     * edits or drops the edits of types that do not mutate entities, and not
     * on rollback, which replays edits a block already accepted.
     */
    private static async refuseUnboundEdits(
        txs: Transaction[],
        isRollback: boolean,
        blockNumber?: number,
    ): Promise<Set<string>> {
        const refused = new Set<string>()
        if (isRollback || txs.length === 0) return refused

        // For a block being synced a refusal means its forger shipped a
        // transaction this node would not have accepted.
        const refuse = (tx: Transaction, reason: string | undefined) => {
            log.error(
                `[applyTransactions] Refusing tx ${tx.hash}` +
                    (blockNumber !== undefined ? ` of block ${blockNumber}` : "") +
                    `: ${reason}`,
            )
            refused.add(tx.hash)
        }

        // One read of the tip decides whether edits are bound, the shape
        // expected of an amount and the governance rule, once for the block:
        // none of them depends on the transaction.
        const { active, postFork, governance, stakeChecks } =
            await editBindingState()
        for (const tx of txs) {
            const reason =
                governanceGateRefusal(tx, governance) ??
                (stakeChecks ? stakeSenderRefusal(tx) : null)
            if (reason) refuse(tx, reason)
        }
        if (!active) return refused

        for (const tx of txs) {
            if (refused.has(tx.hash)) continue
            let verdict: Awaited<ReturnType<typeof verifyEditsAtApply>>
            try {
                verdict = await verifyEditsAtApply(tx, { postFork })
            } catch (error) {
                verdict = { ok: false, reason: `could not be verified: ${error}` }
            }
            if (!verdict.ok) refuse(tx, verdict.reason)
        }
        return refused
    }

    /**
     * The transactions prepareEntities could not load the rows of (see
     * unloadableEditKey): they fail here, the same way on every node, instead
     * of failing the block. An account key createAccount would refuse is
     * looked up first, so an existing row of that shape is edited, not
     * refused; only storable keys are queried. Rollback is not checked: it
     * replays only transactions that applied, whose rows loaded.
     */
    static async refuseUnloadableKeys(
        txs: Transaction[],
        blockNumber?: number,
    ): Promise<Set<string>> {
        const uncreatable = new Set<string>()
        const collect = (account: unknown, loaded: boolean): string | null => {
            const problem = accountKeyProblem(account, false)
            if (problem === null && loaded) {
                const pubkey = normalizePubkey(account as string)
                if (uncreatableAccountKey(pubkey) !== null) uncreatable.add(pubkey)
            }
            return problem
        }
        for (const tx of txs) unloadableEditKey(tx, collect)
        const stored = uncreatable.size === 0 ? NO_KEYS : await this.storedAccountKeys(uncreatable)

        const refused = new Set<string>()
        for (const tx of txs) {
            const reason = unloadableEditKey(tx, (account, loaded) =>
                accountKeyProblem(account, loaded, stored),
            )
            if (reason === null) continue
            log.error(
                `[applyTransactions] Refusing tx ${tx.hash}` +
                    (blockNumber !== undefined ? ` of block ${blockNumber}` : "") +
                    `: ${reason}`,
            )
            refused.add(tx.hash)
        }
        return refused
    }

    /** Which of `pubkeys` have a gcr_main row. */
    private static async storedAccountKeys(pubkeys: Set<string>): Promise<Set<string>> {
        const rows = await dataSource
            .getRepository(GCRMain)
            .find({ where: { pubkey: In([...pubkeys]) }, select: { pubkey: true } })
        return new Set(rows.map(row => row.pubkey))
    }

    /**
     * Adds to `refused` the transactions whose nonce edit is not the one
     * `nonceIntegrity` binds: refused before apply, so they change nothing
     * and spend no nonce, since the account they would charge is not proven.
     */
    private static refuseUnboundNonceEdits(
        txs: Transaction[],
        refused: Set<string>,
        blockNumber?: number,
    ) {
        for (const tx of txs) {
            if (refused.has(tx.hash)) continue
            const verdict = verifyNonceEditBinding(tx)
            if (!verdict.ok) {
                log.error(
                    `[applyTransactions] Refusing tx ${tx.hash}` +
                        (blockNumber !== undefined ? ` of block ${blockNumber}` : "") +
                        `: ${verdict.reason}`,
                )
                refused.add(tx.hash)
            }
        }
    }

    static async applyTransactions(
        txs: Transaction[],
        isRollback: boolean,
        clock?: BlockClock,
        options: ApplyTransactionsOptions = {},
    ): Promise<ApplyTransactionsResult> {
        log.debug("Applying GCR Edits for merged mempool (parallel groups)")
        const now = Date.now()
        const skippedTxs: string[] = []
        const assignedTxsUpdates = new Map<string, AssignedTxRecord[]>()

        const refused = await this.refuseUnboundEdits(txs, isRollback, clock?.height)
        const binding =
            !isRollback && txs.length > 0 ? await editBindingState() : null
        const nonceRule = binding?.nonceBound ?? false
        const osAmounts = binding?.postFork ?? false
        if (nonceRule) {
            this.refuseUnboundNonceEdits(txs, refused, clock?.height)
        }
        const candidates =
            refused.size > 0 ? txs.filter(tx => !refused.has(tx.hash)) : txs

        // filter out txs that don't mutate entities
        const toFilter = new Set<TransactionContent["type"]>([
            "web2Request",
            "storage",
            "escrow",
        ])
        let finalTxs = []

        for (const tx of candidates) {
            if (toFilter.has(tx.content.type)) {
                // These types don't mutate GCR entities, but their universal
                // edits (nonce increment + gas) must still apply; only the
                // type-specific edits are skipped
                const universalEdits = (tx.content.gcr_edits ?? []).filter(
                    edit => edit.type === "nonce" || edit.type === "balance",
                )

                if (universalEdits.length > 0) {
                    const reduced = Object.assign(
                        Object.create(Object.getPrototypeOf(tx)),
                        tx,
                        {
                            content: {
                                ...tx.content,
                                gcr_edits: universalEdits,
                            },
                        },
                    ) as Transaction
                    finalTxs.push(reduced)
                    continue
                }

                skippedTxs.push(tx.hash)

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
                log.error("Confirmed txs: " + JSON.stringify(Array.from(confirmed), null, 2))
                if (debugAssertionsEnabled()) {
                    // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
                    // fetch confirmed txs from db
                    const confirmedTxs = await Chain.getTransactionsFromHashes(Array.from(confirmed))
                    log.error("Confirmed txs full: " + JSON.stringify(confirmedTxs.map(t => t.hash), null, 2))
                    process.exit(1)
                }

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

        // Epic #21 #204: derive gasFeeSeparation fee-distribution edits at
        // APPLY time from each tx's SDK-shipped transaction_fee. Deriving
        // here — before prepareEntities + partitionIndependentTxs — means the
        // fee accounts (burn/treasury) are loaded into the entity cache and
        // grouped correctly. Every node derives identical edits from the same
        // shipped fee, so applied state never diverges.
        //
        // The edits go onto a copy. The caller persists and serves these same
        // tx objects: prepending in place stored the fee edits with the tx,
        // a syncing node then prepended them a second time, and its
        // forged-edit guard refused the tx it had just been sent. Rollback
        // derives too, because the stored tx no longer carries them.
        finalTxs = finalTxs.map(withDerivedFeeEdits)

        // A block touches each Work, slot and storage address from at most one
        // transaction; later ones are refused. Rollback depends on it: every
        // record then changed once in the block being undone.
        //
        // "Later" is judged in the canonical order, not in whatever order this
        // caller passed. The forging and the syncing paths arrive with their
        // own orderings, and a winner picked by input position could differ
        // between them for the same block.
        const blockOrder = finalTxs
        // Before contention, so a transaction that can never apply does not
        // win a Work, slot or address over one that can.
        const unkeyed = isRollback
            ? new Set<string>()
            : await this.refuseUnloadableKeys(finalTxs, clock?.height)
        if (unkeyed.size > 0) {
            finalTxs = finalTxs.filter(tx => !unkeyed.has(tx.hash))
        }
        const contended = this.contendedInBlock(finalTxs)
        if (contended.size > 0) {
            log.warning(
                `[applyTransactions] ${contended.size} tx(s) touch Work state already touched earlier in this block`,
            )
            finalTxs = finalTxs.filter(tx => !contended.has(tx.hash))
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

        const CONCURRENCY = 8
        const groupResults: Awaited<ReturnType<typeof HandleGCR.runGroup>>[] =
            []
        for (let i = 0; i < groups.length; i += CONCURRENCY) {
            const slice = groups.slice(i, i + CONCURRENCY)
            const sliceResults = await Promise.all(
                slice.map(group =>
                    HandleGCR.runGroup(
                        group,
                        entities,
                        isRollback,
                        txIndex,
                        clock,
                        nonceRule,
                        osAmounts,
                    ),
                ),
            )
            groupResults.push(...sliceResults)
        }

        // Merge group results. Senders only appear in one group (sender
        // pubkey unions all their txs), so assignedTxs keys are disjoint.
        const successfulSet = new Set<string>()
        const failedSet = new Set<string>()
        const chargedSet = new Set<string>()
        const allIndexedSideEffects: IndexedSideEffect[] = []
        const allIndexedDeferredWrites: IndexedDeferredWrite[] = []

        for (const r of groupResults) {
            for (const h of r.successful) successfulSet.add(h)
            for (const h of r.failed) failedSet.add(h)
            for (const h of r.nonceCharged) chargedSet.add(h)
            allIndexedSideEffects.push(...r.sideEffects)
            allIndexedDeferredWrites.push(...r.deferredWrites)
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
        allIndexedDeferredWrites.sort((a, b) => a.txIndex - b.txIndex)
        const mergedDeferredWrites = allIndexedDeferredWrites.map(s => s.fn)

        // Preserve original tx order in returned arrays.
        const successfulTxs: string[] = []
        const failedTxs: string[] = []
        for (const h of contended) failedSet.add(h)
        for (const h of unkeyed) failedSet.add(h)
        for (const tx of blockOrder) {
            if (successfulSet.has(tx.hash)) successfulTxs.push(tx.hash)
            else if (failedSet.has(tx.hash)) failedTxs.push(tx.hash)
        }
        if (refused.size > 0) {
            // Reported in the order they arrived, among the ones that failed.
            const failedAll = new Set([...failedTxs, ...refused])
            failedTxs.length = 0
            for (const tx of txs) {
                if (failedAll.has(tx.hash)) failedTxs.push(tx.hash)
            }
        }

        let pending: PendingGCRWrite | undefined
        if (options.defer) {
            pending = HandleGCR.pendingWrite(
                entities,
                assignedTxsUpdates,
                mergedSideEffects,
                mergedDeferredWrites,
            )
        } else {
            await HandleGCR.gcrWriteMutex.runExclusive(async () => {
                // The assignments are the record of which transactions took
                // effect, so they share the edits' database transaction: a
                // failure leaves neither, never edits without their record.
                await this.saveGCREditChanges(
                    entities,
                    mergedSideEffects,
                    assignedTxsUpdates,
                    mergedDeferredWrites,
                )
            })
        }

        const end = Date.now()
        log.only(
            `[applyTransactions] Time taken: ${(end - now) / 1000}s for ${finalTxs.length} txs across ${groups.length} groups (${txs.length - finalTxs.length} non-state-mutating skipped)`,
        )
        log.only(
            `[applyTransactions] Non-state-mutating skipped: ${txs.length - finalTxs.length}`,
        )
        log.only(`[applyTransactions] Total txs: ${txs.length}`)

        const result: ApplyTransactionsResult = {
            successfulTxs,
            failedTxs,
            skippedTxs,
            pending,
        }
        if (nonceRule) {
            result.nonceChargedTxs = blockOrder
                .filter(tx => chargedSet.has(tx.hash))
                .map(tx => tx.hash)
        }
        return result
    }

    /**
     * The validators repository for one stake edit: reads come from the
     * rows this set already touched, then the database; saves are staged
     * for the block's transaction and kept for the next edit to read.
     */
    static stagedValidatorsRepo(
        entities: GCREntityCaches,
        staged: DeferredWrite[],
    ): Repository<Validators> {
        const cache = (entities.validators ??= new Map())
        const repo = dataSource.getRepository(Validators)
        const stagedRepo = stagedRepository(repo, staged, row => {
            if (row.address) cache.set(row.address, row)
        })
        return new Proxy(stagedRepo, {
            get(target, property, receiver) {
                if (property === "findOneBy") {
                    return async (where: { address: string }) => {
                        if (cache.has(where.address)) {
                            return cache.get(where.address)
                        }
                        const row = await repo.findOneBy(where)
                        cache.set(where.address, row)
                        return row
                    }
                }
                return Reflect.get(target, property, receiver)
            },
        })
    }

    /**
     * The governance repositories for one edit: proposals and votes this set
     * already staged are read back, including by the open-proposal and
     * highest-version queries, and saves are staged for the block's
     * transaction.
     */
    static stagedGovernanceRepos(
        entities: GCREntityCaches,
        staged: DeferredWrite[],
    ): {
        proposals: Repository<NetworkUpgrade>
        votes: Repository<NetworkUpgradeVote>
    } {
        const proposals = (entities.networkUpgrades ??= new Map())
        const votes = (entities.networkUpgradeVotes ??= new Map())
        const proposalRepo = dataSource.getRepository(NetworkUpgrade)
        const voteRepo = dataSource.getRepository(NetworkUpgradeVote)

        const proposalsView = new Proxy(
            stagedRepository(proposalRepo, staged, row =>
                proposals.set(row.proposalId, row),
            ),
            {
                get(target, property, receiver) {
                    if (property === "findOneBy") {
                        return async (where: { proposalId: string }) =>
                            proposals.get(where.proposalId) ??
                            (await proposalRepo.findOneBy(where))
                    }
                    if (property === "find") {
                        return async (options?: FindManyOptions<NetworkUpgrade>) => {
                            const rows = await proposalRepo.find(options)
                            const status = (
                                options?.where as { status?: unknown } | undefined
                            )?.status
                            const wanted =
                                status instanceof FindOperator
                                    ? (status.value as string[])
                                    : status === undefined
                                      ? null
                                      : [status as string]
                            const seen = new Set(rows.map(r => r.proposalId))
                            for (const row of proposals.values()) {
                                if (seen.has(row.proposalId)) continue
                                if (wanted && !wanted.includes(row.status)) continue
                                rows.push(row)
                            }
                            return rows
                        }
                    }
                    if (property === "maximum") {
                        return async (column: keyof NetworkUpgrade) => {
                            let max = await proposalRepo.maximum(
                                column as "version",
                            )
                            for (const row of proposals.values()) {
                                const value = row[column]
                                if (
                                    typeof value === "number" &&
                                    (max === null || value > max)
                                ) {
                                    max = value
                                }
                            }
                            return max
                        }
                    }
                    return Reflect.get(target, property, receiver)
                },
            },
        )

        const votesView = new Proxy(
            stagedRepository(voteRepo, staged, row =>
                votes.set(voteKey(row), row),
            ),
            {
                get(target, property, receiver) {
                    if (property === "findOne") {
                        return async (options: {
                            where: { proposalId: string; voterAddress: string }
                        }) =>
                            votes.get(voteKey(options.where)) ??
                            (await voteRepo.findOne(options))
                    }
                    return Reflect.get(target, property, receiver)
                },
            },
        )

        return { proposals: proposalsView, votes: votesView }
    }

    /** The row caches of a set, loaded for the keys its edits touch. */
    private static readonly ROW_CACHES = [
        "accounts",
        "storagePrograms",
        "tlsNotaries",
        "atomicWorks",
        "resourceSlots",
        "validators",
        "networkUpgrades",
        "networkUpgradeVotes",
    ] as const

    /** The claim caches of a set, which hold every claim of the block so far. */
    private static readonly CLAIM_CACHES = ["zkCommitments", "zkNullifiers"] as const

    /**
     * Replaces every row `entities` loaded with the copy `pending` holds for
     * the same key, and takes over its claims, so a set applied on top of a
     * pending one builds on its edits rather than on the database.
     */
    static overlayPending(entities: GCREntityCaches, pending: PendingGCRWrite) {
        const own = entities as unknown as Record<string, Map<string, unknown> | undefined>
        const theirs = pending.entities as unknown as Record<
            string,
            Map<string, unknown> | undefined
        >
        for (const name of HandleGCR.ROW_CACHES) {
            const mine = own[name]
            const pendingRows = theirs[name]
            if (!mine || !pendingRows) continue
            for (const key of mine.keys()) {
                if (pendingRows.has(key)) {
                    const row = pendingRows.get(key)
                    mine.set(key, row ? structuredClone(row) : row)
                }
            }
        }
        for (const name of HandleGCR.CLAIM_CACHES) {
            if (theirs[name]) own[name] = new Map(theirs[name])
        }
    }

    /** Folds the outcome of a set into `pending`, which commits it with the block. */
    static mergeIntoPending(pending: PendingGCRWrite, result: GCRApplyResult) {
        const own = pending.entities as unknown as Record<string, Map<string, unknown> | undefined>
        const theirs = result.entities as unknown as Record<
            string,
            Map<string, unknown> | undefined
        >
        for (const name of [...HandleGCR.ROW_CACHES, ...HandleGCR.CLAIM_CACHES]) {
            const rows = theirs[name]
            if (!rows || rows.size === 0) continue
            const mine = (own[name] ??= new Map())
            for (const [key, row] of rows) mine.set(key, row)
        }
        pending.sideEffects.push(...result.sideEffects)
        pending.deferredWrites.push(...result.deferredWrites)
    }

    /** A pending write with no edits, for a block whose state comes from elsewhere. */
    static emptyPendingWrite(): PendingGCRWrite {
        return HandleGCR.pendingWrite(
            {
                accounts: new Map(),
                storagePrograms: new Map(),
                tlsNotaries: new Map(),
                atomicWorks: new Map(),
                resourceSlots: new Map(),
            },
            new Map(),
        )
    }

    /** The in-memory outcome of an apply, ready to commit with its block. */
    static pendingWrite(
        entities: GCREntityCaches,
        assignedTxs: Map<string, AssignedTxRecord[]>,
        sideEffects: (() => Promise<void>)[] = [],
        deferredWrites: DeferredWrite[] = [],
    ): PendingGCRWrite {
        const pending: PendingGCRWrite = {
            entities,
            assignedTxs,
            sideEffects,
            deferredWrites,
            write: (em, block) =>
                HandleGCR.writeGCREditChanges(
                    em,
                    pending.entities,
                    pending.assignedTxs,
                    pending.deferredWrites,
                    block,
                ),
            afterCommit: async () => {
                if (pending.entities.storagePrograms.size > 0) {
                    markStorageProgramsDirty()
                }
                await HandleGCR.runSideEffects(pending.sideEffects)
            },
        }
        return pending
    }

    /**
     * Saves all in-memory entity caches to the database and applies side-effects.
     *
     * @param entities All entity caches to flush
     * @param sideEffects The side-effects to apply
     * @param assignedTxs Assignments to record in the same database transaction
     * @param deferredWrites Writes issued inside that same transaction
     */
    static async saveGCREditChanges(
        entities: GCREntityCaches,
        sideEffects: (() => Promise<void>)[],
        assignedTxs?: Map<string, AssignedTxRecord[]>,
        deferredWrites: DeferredWrite[] = [],
    ) {
        const now = Date.now()
        // One database transaction for the whole set: a crash or a failed
        // write part-way leaves none of it on disk rather than, say, a Work's
        // payment without the Work that justified it. Side effects run only
        // once the state they follow from is durable.
        await dataSource.transaction(async em => {
            await HandleGCR.writeGCREditChanges(
                em,
                entities,
                assignedTxs,
                deferredWrites,
            )
        })
        if (entities.storagePrograms.size > 0) markStorageProgramsDirty()

        await HandleGCR.runSideEffects(sideEffects)

        const end = Date.now()
        log.only(
            `[saveGCREditChanges] Time taken: ${(end - now) / 1000}s for ${sideEffects.length} side effects`,
        )
    }

    /**
     * The row's leaf in the storage state root. Null when the row has no
     * leaf spelling (it then fails to save as well); the root computes it
     * from the stored row instead.
     */
    static storageLeafOf(program: GCRStorageProgram): string | null {
        try {
            return storageProgramLeafHex(program)
        } catch (error) {
            log.warning(
                `[saveGCREditChanges] no storage leaf for ${program.storageAddress}: ${error}`,
            )
            return null
        }
    }

    /** Runs side effects in order once the state they follow from is durable. */
    static async runSideEffects(sideEffects: (() => Promise<void>)[]) {
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

    /**
     * Writes the entity caches, the assignment stamps and the deferred writes
     * through one entity manager. The caller owns the transaction. With
     * `historyBlock`, the storage programs' records from before the write go
     * to that block's undo log first.
     */
    static async writeGCREditChanges(
        em: EntityManager,
        entities: GCREntityCaches,
        assignedTxs?: Map<string, AssignedTxRecord[]>,
        deferredWrites: DeferredWrite[] = [],
        historyBlock?: number,
    ) {
        // Save GCRMain entities
        const entitiesToSave = entities.accounts.values().toArray()
        entitiesToSave.sort((a, b) => a.pubkey.localeCompare(b.pubkey))
        if (entitiesToSave.length > 0) {
            log.debug(
                `[saveGCREditChanges] Saving ${entitiesToSave.length} GCRMain entities`,
            )
            const gcrMainRepo = em.getRepository(GCRMain)
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

            // Before the write as well as after the commit: a root computed
            // while this transaction is open must not outlive it.
            markStorageProgramsDirty()
            for (const program of spToSave) {
                program.smtLeaf = HandleGCR.storageLeafOf(program)
            }
            if (historyBlock !== undefined) {
                await recordStorageHistory(em, historyBlock, [
                    ...entities.storagePrograms.keys(),
                ])
            }

            const spRepo = em.getRepository(GCRStorageProgram)
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

            const tlsRepo = em.getRepository(GCRTLSNotary)
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

        if (entities.atomicWorks?.size > 0) {
            const repo = em.getRepository(GCRAtomicWork)
            const toSave: GCRAtomicWork[] = []
            const toDelete: string[] = []
            for (const [workId, record] of entities.atomicWorks) {
                if (record === null) toDelete.push(workId)
                else toSave.push(repo.create(record))
            }
            if (toSave.length > 0) await repo.save(toSave)
            if (toDelete.length > 0) await repo.delete({ workId: In(toDelete) })
        }

        if (entities.resourceSlots?.size > 0) {
            const repo = em.getRepository(GCRResourceSlot)
            const toSave: GCRResourceSlot[] = []
            const toDelete: string[] = []
            for (const [resourceKey, record] of entities.resourceSlots) {
                if (record === null) {
                    toDelete.push(resourceKey)
                    continue
                }
                toSave.push(
                    repo.create({
                        resourceKey,
                        state: record.state,
                        generation: record.generation,
                        workId: "workId" in record ? record.workId : "",
                        record,
                    }),
                )
            }
            if (toSave.length > 0) await repo.save(toSave)
            if (toDelete.length > 0) {
                await repo.delete({ resourceKey: In(toDelete) })
            }
        }

        if (assignedTxs && assignedTxs.size > 0) {
            log.debug(
                `[saveGCREditChanges] Recording ${assignedTxs.size} assignedTxs`,
            )
            await HandleGCR.bulkUpdateAssignedTxs(assignedTxs, em)
        }

        // After the caches, so a write that re-reads an account through
        // the manager sees the balance and nonce this set gives it.
        for (const write of deferredWrites) {
            await write(em)
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
    /**
     * `applyGCREdit`, then a failure if a row it wrote holds what Postgres
     * refuses: the transaction fails and is rolled back instead of the block
     * failing to commit. A rollback writes back rows that were stored, so it
     * is not checked.
     */
    static async applyStorableEdit(
        edit: GCREdit,
        entities: GCREntityCaches,
        isRollback = false,
        simulate = false,
        place?: EditPlace,
    ): Promise<GCRResult> {
        const stored = isRollback ? new Map() : storedIndexes(edit, entities)
        const result = await HandleGCR.applyGCREdit(
            edit,
            entities,
            isRollback,
            simulate,
            place,
        )
        if (!result.success || isRollback) return result
        const where = unstorableAfter(edit, entities, stored)
        return where === null
            ? result
            : { success: false, message: `${where} holds a value Postgres cannot store` }
    }

    static async applyGCREdit(
        editOperation: GCREdit,
        entities: GCREntityCaches,
        isRollback = false,
        simulate = false,
        place?: EditPlace,
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

        // Work edits are newer than some SDK builds' edit union, so they are
        // matched as strings ahead of the typed switch.
        switch (editOperation.type as string) {
            case "work-attempt":
                return applyWorkAttempt(
                    editOperation as unknown as WorkAttemptEdit,
                    entities.atomicWorks,
                    isRollback,
                )
            case "resource-slot-cas":
                return applySlotCas(
                    editOperation as unknown as SlotCasEdit,
                    entities.resourceSlots,
                    isRollback,
                )
            case "storage-program-put":
                return applyAtomicStoragePut(
                    editOperation as unknown as StoragePutEdit,
                    entities.storagePrograms,
                    isRollback,
                )
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
                result = await GCRIdentityRoutines.apply(
                    editOperation,
                    account,
                    undefined,
                    entities,
                    place,
                )
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
            // These routines write their own tables. Their saves are staged
            // and issued in the block's transaction as the edit's deferred
            // write, so a block that fails to commit leaves no row behind.
            case "validatorStake":
                if (simulate) {
                    // Validation already ran during handleStakingTx; we don't
                    // mutate state during mempool simulation.
                    result = { success: true, message: "Simulated" }
                } else {
                    const staged: DeferredWrite[] = []
                    const stakeAccount = (
                        editOperation as unknown as { account: string | Uint8Array }
                    ).account
                    result = await GCRValidatorStakeRoutines.apply(
                        editOperation,
                        HandleGCR.stagedValidatorsRepo(entities, staged),
                        undefined,
                        {
                            account:
                                entities.accounts.get(normalizePubkey(stakeAccount)) ?? null,
                            stagedRows: entities.validators,
                            rollback: isRollback,
                        },
                    )
                    result.deferredWrite = deferredWriteOf(staged)
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
                    const staged: DeferredWrite[] = []
                    const repos = HandleGCR.stagedGovernanceRepos(entities, staged)
                    result = await GCRNetworkUpgradeRoutines.applyProposal(
                        editOperation,
                        repos.proposals,
                        undefined,
                        entities.validators,
                    )
                    result.deferredWrite = deferredWriteOf(staged)
                }
                break
            case "networkUpgradeVote":
                if (simulate) {
                    result = { success: true, message: "Simulated" }
                } else {
                    const { default: GCRNetworkUpgradeRoutines } = await import(
                        "./gcr_routines/GCRNetworkUpgradeRoutines"
                    )
                    const staged: DeferredWrite[] = []
                    const repos = HandleGCR.stagedGovernanceRepos(entities, staged)
                    result = await GCRNetworkUpgradeRoutines.applyVote(
                        editOperation,
                        repos.votes,
                        repos.proposals,
                    )
                    result.deferredWrite = deferredWriteOf(staged)
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
        appliedPlaces: (EditPlace | undefined)[] = [],
    ): Promise<void> {
        // We need to reverse the order of the applied edits
        const appliedEdits = appliedEditsOriginal.reverse()
        const places = [...appliedPlaces].reverse()
        log.info(
            "[rollback] Rolling back " +
                appliedEdits.length +
                " GCREdits for tx: " +
                tx.hash,
        )
        // To rollback the edits, we need to pass the rollback flag to the apply method
        const counter = 0
        const results: GCRResult[] = []

        for (const [i, edit] of appliedEdits.entries()) {
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
                result = await this.applyGCREdit(
                    edit,
                    entities,
                    true,
                    false,
                    places[i],
                )
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
