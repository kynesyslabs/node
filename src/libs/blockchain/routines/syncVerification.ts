import type { Transaction } from "@kynesyslabs/demosdk/types"
import type Block from "../block"
import Chain from "../chain"
import hashGCRTables from "../gcr/gcr_routines/hashGCR"
import TxValidatorPool from "../validation/txValidatorPool"
import { isSystemRelayTx, verifySystemRelayTx } from "../validation/systemRelayTx"
import {
    EXPIRED_TX_DEEP_WINDOW_MULTIPLIER,
    isReferenceBlockAllowed,
    isWithinDeepWindow,
} from "../referenceBlockWindow"
import { filterMempoolByNonce } from "src/libs/consensus/v2/routines/mempoolFilters"
import type { MempoolTransaction } from "src/libs/consensus/v2/routines/mempoolFilters"
import { orderDeterministically } from "src/libs/consensus/v2/routines/deterministicOrder"
import { isForkActive, serializeBlockContent, txSignatureContext } from "@/forks"
import Hashing from "@/libs/crypto/hashing"
import {
    FINALITY_FORK,
    projectedResultsRoot,
} from "../finality/commitments"
import { ErrorCode } from "@/errors"
import { TRANSACTION_STATUS } from "@/utilities/constants"
import { getSharedState } from "@/utilities/sharedState"
import log from "src/utilities/logger"
import { countStorageRootSyncMismatch } from "@/features/metrics/consensusMetrics"

type FinalStatus = typeof TRANSACTION_STATUS.CONFIRMED | typeof TRANSACTION_STATUS.FAILED

/**
 * A served block that must not be applied: what the peer sent disagrees with
 * the quorum-signed block or with what applying it does here. The peer, not
 * the node, is at fault, so callers drop the block and move to another peer.
 */
export class SyncBlockRejectedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SyncBlockRejectedError"
    }
}

type PoolResults = Awaited<ReturnType<TxValidatorPool["validate"]>>

async function validateAtHeight(
    txs: Transaction[],
    height: number,
): Promise<PoolResults> {
    return await TxValidatorPool.getInstance().validate(
        txs,
        isForkActive("osDenomination", height),
        txSignatureContext(height),
    )
}

const SIGNATURE_RULE_FORKS = ["osDenomination", "signatureDomain"] as const

/**
 * Heights whose rules a block's transactions may legitimately have been
 * admitted under, besides the block's own: the height before each fork that
 * activated no more than a deep window ago.
 *
 * The forger admits a tx under the rules of the tip it saw and never
 * revalidates its mempool. A tx kept for a later round (a nonce ahead of its
 * predecessor) can therefore reach a block after a fork activated, for as long
 * as its reference block is still inside the deep window; past that the forger
 * drops it. Every fork rule is judged separately because they activate at
 * different heights.
 */
function previousRuleHeights(height: number): number[] {
    const window =
        EXPIRED_TX_DEEP_WINDOW_MULTIPLIER * getSharedState.referenceBlockRoom
    const heights = new Set<number>()
    for (const fork of SIGNATURE_RULE_FORKS) {
        const activation = getSharedState.forkConfig?.[fork]?.activationHeight
        if (
            activation !== null &&
            activation !== undefined &&
            activation > 0 &&
            height >= activation &&
            height < activation + window
        ) {
            heights.add(activation - 1)
        }
    }
    return [...heights]
}

/**
 * The block hash covers transaction hashes only, so a peer is free to serve
 * any body for them. Each body must hash to the hash the block committed to
 * and carry a valid signature, judged by the rules of the block's own height
 * (and, while a transaction admitted before a fork can still be in a block,
 * those in force before it).
 */
export async function verifyBlockTransactions(
    block: Block,
    txs: Transaction[],
): Promise<void> {
    const committed = block.content.ordered_transactions
    const served = new Set(txs.map(tx => tx.hash))
    if (
        txs.length !== committed.length ||
        served.size !== committed.length ||
        !committed.every(hash => served.has(hash))
    ) {
        throw new SyncBlockRejectedError(
            `transactions served for block ${block.number} do not match the ${committed.length} hashes it commits to`,
        )
    }

    if (txs.length === 0) return

    const verdicts = new Map<string, { valid: boolean; reason?: string }>()
    const relayTxs = txs.filter(isSystemRelayTx)
    const userTxs = txs.filter(tx => !isSystemRelayTx(tx))
    try {
        for (const tx of relayTxs) {
            verdicts.set(tx.hash, await verifySystemRelayTx(tx))
        }

        if (userTxs.length > 0) {
            for (const result of await validateAtHeight(userTxs, block.number)) {
                verdicts.set(result.hash, result)
            }

            for (const height of previousRuleHeights(block.number)) {
                const retry = userTxs.filter(
                    tx => verdicts.get(tx.hash)?.valid !== true,
                )
                if (retry.length === 0) break
                for (const result of await validateAtHeight(retry, height)) {
                    if (result.valid) verdicts.set(result.hash, result)
                }
            }
        }
    } catch (e) {
        throw new SyncBlockRejectedError(
            `could not validate transactions of block ${block.number}: ${e instanceof Error ? e.message : String(e)}`,
        )
    }

    const invalid = txs.filter(tx => verdicts.get(tx.hash)?.valid !== true)
    for (const tx of invalid) {
        log.error(
            `[syncVerify] block ${block.number} tx ${tx.hash} rejected: ${verdicts.get(tx.hash)?.reason ?? "no verdict"}`,
        )
    }
    if (invalid.length > 0) {
        throw new SyncBlockRejectedError(
            `${invalid.length} transaction(s) of block ${block.number} failed hash or signature validation, first ${invalid[0].hash}: ${verdicts.get(invalid[0].hash)?.reason ?? "no verdict"}`,
        )
    }
}

/**
 * Left out of the comparison: its hash covers a `createdAt` the database
 * stamps with each node's own clock, so no two nodes hold the same value for
 * the same row and the entry cannot match across nodes.
 */
const NODE_LOCAL_TABLE_HASHES = new Set(["native_tlsnotary"])

/**
 * The storage root. A difference is counted before the block is refused, so
 * a root that diverges on a live network shows up in the metrics too.
 */
const STORAGE_ROOT_KEY = "native_storage_programs"

/**
 * `native_tables_hashes` is taken by the forger before it applies the block,
 * so it commits to the state this node holds right before applying the same
 * block. Call it at that point; a divergence left by the previous block
 * surfaces here and stops the sync before more state is built on it.
 */
export async function verifyNativeTablesHashes(block: Block): Promise<void> {
    const committed = block.content.native_tables_hashes as unknown as
        | Record<string, string>
        | undefined
    const local = (await hashGCRTables(block.number)) as unknown as Record<
        string,
        string
    >

    const keys = new Set([...Object.keys(committed ?? {}), ...Object.keys(local)])
    const differing = [...keys].filter(
        key =>
            !NODE_LOCAL_TABLE_HASHES.has(key) && committed?.[key] !== local[key],
    )
    if (
        differing.includes(STORAGE_ROOT_KEY) &&
        committed &&
        STORAGE_ROOT_KEY in committed &&
        STORAGE_ROOT_KEY in local
    ) {
        countStorageRootSyncMismatch()
        log.error(
            `[syncVerify] storage root of block ${block.number} differs from local state: block ${committed[STORAGE_ROOT_KEY]}, local ${local[STORAGE_ROOT_KEY]}`,
        )
    }
    if (!committed || differing.length > 0) {
        throw new SyncBlockRejectedError(
            `native table hashes of block ${block.number} differ from local state: ${committed ? differing.join(", ") : "block carries none"}`,
        )
    }
}

export interface BlockOutcomePlan {
    /** Transactions the forger ran through apply, in canonical order. */
    toApply: Transaction[]
    /** Transactions that fail before apply, with the reason. */
    failedBeforeApply: Map<string, string>
}

const statusOf = (tx: Transaction) => tx.status

/**
 * Re-derives which transactions the forger excluded before applying: those
 * already on chain, those past their reference-block window and those whose
 * nonce is already spent. Everything else was applied and its status is
 * decided by the apply itself, which the caller runs locally.
 *
 * The reference block of a transaction is not part of what the sender signs;
 * it is read from the attrs the peer served. That is a limit of this check: a
 * peer can serve an expired tx as confirmed with an in-window reference block
 * and nothing here can tell. Closing it needs the block to commit to the attrs.
 */
export async function planBlockOutcome(
    block: Block,
    txs: Transaction[],
): Promise<BlockOutcomePlan> {
    const sorted = orderDeterministically(txs)
    const head = block.number - 1
    const failedBeforeApply = new Map<string, string>()

    for (const tx of sorted) {
        const status = statusOf(tx)
        if (
            status !== TRANSACTION_STATUS.CONFIRMED &&
            status !== TRANSACTION_STATUS.FAILED
        ) {
            throw new SyncBlockRejectedError(
                `tx ${tx.hash} of block ${block.number} has status "${String(status)}", expected confirmed or failed`,
            )
        }
    }

    const onChain = await Chain.getExistingTransactionHashes(
        sorted.map(tx => tx.hash),
    )

    const candidates: MempoolTransaction[] = []
    for (const tx of sorted) {
        if (onChain.has(tx.hash)) {
            failedBeforeApply.set(tx.hash, ErrorCode.TX_EXISTS)
            continue
        }

        const reference = tx.attrs?.reference_block
        const copy = Object.assign(
            Object.create(Object.getPrototypeOf(tx)),
            tx,
            { reference_block: reference },
        ) as MempoolTransaction

        if (
            typeof reference === "number" &&
            !isReferenceBlockAllowed(reference, head)
        ) {
            // Outside the deep window the forger never admits the tx at all,
            // so it cannot be in a block, failed or not.
            if (!isWithinDeepWindow(reference, head)) {
                throw new SyncBlockRejectedError(
                    `tx ${tx.hash} of block ${block.number} has reference block ${reference} outside the admissible window at ${head}`,
                )
            }
            failedBeforeApply.set(
                tx.hash,
                ErrorCode.TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE,
            )
            copy.status = TRANSACTION_STATUS.FAILED
        } else {
            copy.status = TRANSACTION_STATUS.PENDING
        }
        candidates.push(copy)
    }

    // The forger's own nonce pass, on the nonces this node holds before the
    // block: it marks stale nonces failed and leaves out the ones ahead of
    // the account, which a block cannot carry.
    const nonceVerdict = await filterMempoolByNonce(candidates)
    const kept = new Set(nonceVerdict.validTxs.map(tx => tx.hash))
    for (const tx of candidates) {
        if (!kept.has(tx.hash)) {
            throw new SyncBlockRejectedError(
                `tx ${tx.hash} of block ${block.number} has a nonce ahead of its account`,
            )
        }
    }
    for (const tx of nonceVerdict.validTxs) {
        if (
            tx.status === TRANSACTION_STATUS.FAILED &&
            !failedBeforeApply.has(tx.hash)
        ) {
            failedBeforeApply.set(tx.hash, ErrorCode.TX_NONCE_INVALID_LOW)
        }
    }

    for (const tx of sorted) {
        const reason = failedBeforeApply.get(tx.hash)
        if (reason && statusOf(tx) !== TRANSACTION_STATUS.FAILED) {
            throw new SyncBlockRejectedError(
                `tx ${tx.hash} of block ${block.number} is served as confirmed but fails before apply here (${reason})`,
            )
        }
    }

    return {
        toApply: sorted.filter(tx => !failedBeforeApply.has(tx.hash)),
        failedBeforeApply,
    }
}

export interface ApplyOutcome {
    successfulTxs: string[]
    skippedTxs: string[]
    failedTxs: string[]
}

/**
 * Local outcome per transaction: confirmed when apply succeeded or the type
 * mutates nothing, failed otherwise (including a tx apply dropped).
 */
export function localStatuses(
    plan: BlockOutcomePlan,
    outcome: ApplyOutcome,
): Map<string, FinalStatus> {
    const succeeded = new Set([...outcome.successfulTxs, ...outcome.skippedTxs])
    const statuses = new Map<string, FinalStatus>()
    for (const hash of plan.failedBeforeApply.keys()) {
        statuses.set(hash, TRANSACTION_STATUS.FAILED)
    }
    for (const tx of plan.toApply) {
        statuses.set(
            tx.hash,
            succeeded.has(tx.hash)
                ? TRANSACTION_STATUS.CONFIRMED
                : TRANSACTION_STATUS.FAILED,
        )
    }
    return statuses
}

/**
 * The block does not commit to transaction attrs, so the failure code of a
 * transaction this node also saw fail before apply is taken from the local
 * derivation, not from the peer. Failures inside apply keep the served code:
 * the local apply does not report one. TX_EXISTS is left alone: the forger
 * checks nonce and reference block first, so an honest code can differ.
 */
export function pinFailureCodes(txs: Transaction[], plan: BlockOutcomePlan): void {
    for (const tx of txs) {
        const code = plan.failedBeforeApply.get(tx.hash)
        if (code === undefined || code === ErrorCode.TX_EXISTS || tx.attrs?.code === code) continue
        // The served code is unsigned peer data; never convert it to text.
        const served = tx.attrs?.code
        const shown = typeof served === "string" ? JSON.stringify(served.slice(0, 64)) : typeof served
        log.warn(`[sync] tx ${tx.hash}: served failure code ${shown} replaced by local ${code}`)
        tx.attrs = { ...(tx.attrs ?? {}), code }
    }
}

/**
 * Under `finalityProofs` the code is part of the result the next block
 * commits to, so the stored code must be what this node derives, never what
 * the peer served: a stored code changes only by repair against a later
 * verified block. A transaction
 * that failed inside apply was given TX_EXECUTE_FAILED by the forger, and a
 * confirmed one carries no code. The served statuses already agree with the
 * local outcome.
 */
export function pinResultCodes(
    txs: Transaction[],
    plan: BlockOutcomePlan,
    height: number,
): void {
    if (!isForkActive(FINALITY_FORK, height)) return
    for (const tx of txs) {
        if (tx.status === TRANSACTION_STATUS.CONFIRMED) {
            if (tx.attrs && "code" in tx.attrs) {
                log.warn(`[sync] tx ${tx.hash}: served code on a confirmed transaction dropped`)
                const { code: _served, ...rest } = tx.attrs
                tx.attrs = rest as typeof tx.attrs
            }
            continue
        }
        if (
            tx.status !== TRANSACTION_STATUS.FAILED ||
            plan.failedBeforeApply.has(tx.hash) ||
            tx.attrs?.code === ErrorCode.TX_EXECUTE_FAILED
        ) {
            continue
        }
        log.warn(`[sync] tx ${tx.hash}: served failure code replaced by ${ErrorCode.TX_EXECUTE_FAILED}`)
        tx.attrs = {
            ...(tx.attrs ?? {}),
            code: ErrorCode.TX_EXECUTE_FAILED,
        } as typeof tx.attrs
    }
}

/** Hashes whose served status differs from the locally derived one. */
export function statusDisagreements(
    txs: Transaction[],
    local: Map<string, FinalStatus>,
): string[] {
    return txs
        .filter(tx => local.get(tx.hash) !== tx.status)
        .map(tx => tx.hash)
}

/**
 * Before block N is applied with `txs`, the results it will store must give
 * the `parent_results_root` that block N + 1 commits to, when N + 1 is in
 * hand. Statuses and codes are already derived locally; this catches any
 * remaining disagreement before the rows are stored: once N is stored its
 * statuses are final and its failure codes change only by repair.
 *
 * Only a next block that hashes to its own hash and builds on `block` is
 * compared; anything else is judged as a block on its own turn. It is not
 * signature-checked yet (its committee depends on `block`), so a mismatch
 * rejects what this peer served, and nothing about this node's state.
 */
export async function checkResultsAgainstNextBlock(
    block: Block,
    txs: Transaction[],
    next: Block | undefined,
): Promise<void> {
    if (
        !next ||
        next.number !== block.number + 1 ||
        !isForkActive(FINALITY_FORK, next.number) ||
        next.content?.previousHash !== block.hash
    ) {
        return
    }
    if (
        Hashing.sha256(serializeBlockContent(next.content, next.number)) !==
        next.hash
    ) {
        return
    }

    const committed = (next.content as unknown as Record<string, unknown>)
        .parent_results_root
    let local: string
    try {
        local = await projectedResultsRoot(block, txs)
    } catch (e) {
        throw new SyncBlockRejectedError(
            `cannot derive the results of block ${block.number}: ${e instanceof Error ? e.message : String(e)}`,
        )
    }
    if (committed !== local) {
        throw new SyncBlockRejectedError(
            `results of block ${block.number} give ${local}, block ${next.number} commits ${String(committed)}`,
        )
    }
}
