import type { Transaction } from "@kynesyslabs/demosdk/types"
import type Block from "../block"
import Chain from "../chain"
import hashGCRTables from "../gcr/gcr_routines/hashGCR"
import TxValidatorPool from "../validation/txValidatorPool"
import { isSystemRelayTx, verifySystemRelayTx } from "../validation/systemRelayTx"
import { isReferenceBlockAllowed, isWithinDeepWindow } from "../referenceBlockWindow"
import { filterMempoolByNonce } from "src/libs/consensus/v2/routines/mempoolFilters"
import type { MempoolTransaction } from "src/libs/consensus/v2/routines/mempoolFilters"
import { orderDeterministically } from "src/libs/consensus/v2/routines/deterministicOrder"
import { isForkActive, txSignatureContext } from "@/forks"
import { ErrorCode } from "@/errors"
import { TRANSACTION_STATUS } from "@/utilities/constants"
import log from "src/utilities/logger"

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

/**
 * The forger admits a tx at the tip and never revalidates its mempool, so a
 * tx admitted just before a fork activates can sit in the activation block
 * itself. That block is the only height where the previous height's rules
 * also applied to what it carries.
 */
function isActivationBlock(height: number): boolean {
    return (["osDenomination", "signatureDomain"] as const).some(
        fork => isForkActive(fork, height) && !isForkActive(fork, height - 1),
    )
}

/**
 * The block hash covers transaction hashes only, so a peer is free to serve
 * any body for them. Each body must hash to the hash the block committed to
 * and carry a valid signature, judged by the rules of the block's own height
 * (and, in a fork's activation block, those of the height before it).
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

            if (isActivationBlock(block.number)) {
                const retry = userTxs.filter(
                    tx => verdicts.get(tx.hash)?.valid !== true,
                )
                if (retry.length > 0) {
                    for (const result of await validateAtHeight(
                        retry,
                        block.number - 1,
                    )) {
                        if (result.valid) verdicts.set(result.hash, result)
                    }
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

/** Hashes whose served status differs from the locally derived one. */
export function statusDisagreements(
    txs: Transaction[],
    local: Map<string, FinalStatus>,
): string[] {
    return txs
        .filter(tx => local.get(tx.hash) !== tx.status)
        .map(tx => tx.hash)
}
