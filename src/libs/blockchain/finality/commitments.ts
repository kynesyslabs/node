/**
 * Finality commitments (`finalityProofs` fork).
 *
 * A block is forged and voted on before its transactions execute, so block N
 * can only commit to what block N - 1 left behind: its height, the RFC 6962
 * root of block N - 1's transaction results, and the hash of the validator
 * set after block N - 1, which the committee for block N + 1 is drawn from. A
 * client holding a signed block N then proves the outcome of a transaction in
 * block N - 1 with log2(n) hashes, and follows the committee forward.
 *
 * Every member forges the block on its own and votes only on an identical
 * hash, so the commitments are a pure function of committed database state:
 * the parent block, its transaction rows and the validator set snapshot,
 * which all commit in the parent's own insert transaction before the next
 * height is forged or verified.
 */

import Chain from "src/libs/blockchain/chain"
import { isForkActive } from "@/forks/forkGates"
import { ErrorCode } from "@/errors/codes"
import { jcsCanonicalize } from "src/libs/crypto/jcs"
import { TRANSACTION_STATUS } from "@/utilities/constants"

export const FINALITY_FORK = "finalityProofs" as const

/**
 * Content keys this fork appends after `native_tables_hashes`, in the order
 * they are hashed.
 */
export const COMMITMENT_KEYS = [
    "number",
    "parent_results_root",
    "validator_set_hash",
] as const

export interface FinalityCommitments {
    number: number
    parent_results_root: string
    validator_set_hash: string
}

/** What the result leaf of a transaction is built from: its stored row. */
export interface ResultRow {
    hash: string
    status: unknown
    attrs?: { code?: unknown } | null
    blockNumber: number
}

export interface CommitmentVerdict {
    valid: boolean
    reason?: string
}

export class FinalityCommitmentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "FinalityCommitmentError"
    }
}

const HASH_HEX = /^[0-9a-f]{64}$/

export function isCommitmentHash(value: unknown): value is string {
    return typeof value === "string" && HASH_HEX.test(value)
}

// The tree pulls an ESM-only hash library; loading it on first use keeps the
// fork-inactive paths free of it.
async function loadTree() {
    return await import("src/libs/crypto/merkle/rfc6962")
}

/** sha256 of the empty string: the result root of a block with no transactions. */
export const EMPTY_RESULTS_ROOT =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

/**
 * Leaf data of one transaction's result in block `parentNumber`:
 * `jcs({code, hash, status})`, the code of a failure as a string, otherwise
 * null.
 *
 * A row stored with another block is a transaction that was already on chain
 * when this block carried it again: its insert was skipped, and in this block
 * it did not execute.
 */
export function resultLeaf(row: ResultRow, parentNumber: number): Uint8Array {
    if (row.blockNumber !== parentNumber) {
        return encodeLeaf(row.hash, TRANSACTION_STATUS.FAILED, ErrorCode.TX_EXISTS)
    }
    if (
        row.status !== TRANSACTION_STATUS.CONFIRMED &&
        row.status !== TRANSACTION_STATUS.FAILED
    ) {
        throw new FinalityCommitmentError(
            `tx ${row.hash} of block ${parentNumber} has status "${String(row.status)}", expected confirmed or failed`,
        )
    }
    // attrs are unsigned and outside the block hash: only a failure carries a
    // code that every node derives, so a code relayed on a confirmed row
    // must not reach the leaf.
    const code = row.status === TRANSACTION_STATUS.FAILED ? row.attrs?.code : null
    return encodeLeaf(row.hash, row.status, typeof code === "string" ? code : null)
}

function encodeLeaf(hash: string, status: string, code: string | null): Uint8Array {
    return new TextEncoder().encode(jcsCanonicalize({ code, hash, status }))
}

/**
 * RFC 6962 root, lowercase hex, over the results of `orderedHashes` in that
 * order. Every hash must have a row: a missing one is local state this node
 * cannot commit to.
 */
export async function resultsRoot(
    orderedHashes: string[],
    rows: Map<string, ResultRow>,
    parentNumber: number,
): Promise<string> {
    if (orderedHashes.length === 0) return EMPTY_RESULTS_ROOT
    const leaves = resultLeaves(orderedHashes, rows, parentNumber)
    const { root, toHex } = await loadTree()
    return toHex(root(leaves))
}

/** The leaf data of `orderedHashes`, in that order; see `resultsRoot`. */
export function resultLeaves(
    orderedHashes: string[],
    rows: Map<string, ResultRow>,
    parentNumber: number,
): Uint8Array[] {
    return orderedHashes.map(hash => {
        const row = rows.get(hash)
        if (!row) {
            throw new FinalityCommitmentError(
                `no stored result for tx ${hash} of block ${parentNumber}`,
            )
        }
        return resultLeaf(row, parentNumber)
    })
}

async function readResultRows(hashes: string[]): Promise<Map<string, ResultRow>> {
    const unique = [...new Set(hashes)]
    const rows = new Map<string, ResultRow>()
    if (unique.length === 0) return rows
    for (const tx of await Chain.getTransactionsFromHashes(unique)) {
        rows.set(tx.hash, {
            hash: tx.hash,
            status: tx.status,
            attrs: tx.attrs as { code?: unknown } | null,
            blockNumber: Number(tx.blockNumber),
        })
    }
    return rows
}

interface ParentBlock {
    number: number
    hash: string
    content: { ordered_transactions?: string[] }
}

// Rows of an inserted block never change, so the root is kept per parent
// hash: the forge, the vote and verification of one height read it in turn.
const ROOT_CACHE_MAX_ENTRIES = 8
const rootCache = new Map<string, string>()

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetCommitmentCache(): void {
    rootCache.clear()
}

/** Result root of an inserted block, read from its stored transaction rows. */
export async function parentResultsRoot(parent: ParentBlock): Promise<string> {
    const hashes = parent.content?.ordered_transactions ?? []
    // Genesis carries its seeding transaction, which is not a result.
    if (parent.number < 1 || hashes.length === 0) return EMPTY_RESULTS_ROOT

    const cached = rootCache.get(parent.hash)
    if (cached !== undefined) return cached

    const rows = await readResultRows(hashes)
    const root = await resultsRoot(hashes, rows, parent.number)
    rootCache.set(parent.hash, root)
    if (rootCache.size > ROOT_CACHE_MAX_ENTRIES) {
        rootCache.delete(rootCache.keys().next().value)
    }
    return root
}

/**
 * The result leaves of an inserted block, read from its stored rows: the
 * exact data block `block.number + 1` commits to in `parent_results_root`.
 * Genesis commits none.
 */
export async function blockResultLeaves(block: ParentBlock): Promise<Uint8Array[]> {
    const hashes = block.content?.ordered_transactions ?? []
    if (block.number < 1 || hashes.length === 0) return []
    return resultLeaves(hashes, await readResultRows(hashes), block.number)
}

/**
 * Hash of the validator set after block `height`, from its snapshot.
 *
 * @throws FinalityCommitmentError when this node holds no snapshot that old
 */
export async function committedValidatorSetHash(height: number): Promise<string> {
    // Loaded on first use: the snapshot reader opens the database.
    const { validatorSetAt } = await import("./validatorSet")
    const snapshot = await validatorSetAt(height)
    if (!snapshot) {
        throw new FinalityCommitmentError(
            `no validator set snapshot at or below block ${height}`,
        )
    }
    return snapshot.setHash
}

/**
 * The commitments block `blockNumber` carries, or null before the fork.
 *
 * @throws FinalityCommitmentError when the parent or one of its results is
 *   not in the database: forging would commit to a guess.
 */
export async function buildCommitments(
    blockNumber: number,
): Promise<FinalityCommitments | null> {
    if (blockNumber < 1 || !isForkActive(FINALITY_FORK, blockNumber)) {
        return null
    }
    const parent = await Chain.getBlockByNumber(blockNumber - 1)
    if (!parent) {
        throw new FinalityCommitmentError(
            `block ${blockNumber - 1} not found; cannot commit to its results`,
        )
    }
    return {
        number: blockNumber,
        parent_results_root: await parentResultsRoot(parent),
        validator_set_hash: await committedValidatorSetHash(blockNumber - 1),
    }
}

/**
 * Checks the commitments of `block` against local state. Before the fork the
 * keys must be absent; after it they must be present, last in the content in
 * their fixed order, and equal to what this node derives from its own rows.
 */
export async function verifyCommitments(
    block: { number: number; content: unknown },
    prevBlock: ParentBlock,
): Promise<CommitmentVerdict> {
    const content = (block.content ?? {}) as Record<string, unknown>
    const keys: readonly string[] = COMMITMENT_KEYS

    if (!isForkActive(FINALITY_FORK, block.number)) {
        const present = keys.filter(key =>
            Object.prototype.hasOwnProperty.call(content, key),
        )
        if (present.length > 0) {
            return {
                valid: false,
                reason: `block ${block.number} carries ${present.join(", ")} before finalityProofs`,
            }
        }
        return { valid: true }
    }

    // Fixed position, so a client can locate them in the signed bytes and
    // two honest forgers can never hash a different key order.
    const trailing = Object.keys(content).slice(-keys.length)
    if (trailing.join(",") !== keys.join(",")) {
        return {
            valid: false,
            reason: `block ${block.number} does not end with ${keys.join(", ")} (found ${trailing.join(", ") || "none"})`,
        }
    }
    if (content.number !== block.number) {
        return {
            valid: false,
            reason: `block ${block.number} commits to number ${JSON.stringify(content.number)}`,
        }
    }
    if (!isCommitmentHash(content.parent_results_root)) {
        return {
            valid: false,
            reason: `block ${block.number} has a malformed parent_results_root`,
        }
    }

    let expected: string
    try {
        expected = await parentResultsRoot(prevBlock)
    } catch (e) {
        return {
            valid: false,
            reason: `cannot derive the result root of block ${prevBlock.number}: ${e instanceof Error ? e.message : String(e)}`,
        }
    }
    if (content.parent_results_root !== expected) {
        return {
            valid: false,
            reason: `parent_results_root mismatch: block ${block.number} commits ${content.parent_results_root}, local results of block ${prevBlock.number} give ${expected}`,
        }
    }

    if (!isCommitmentHash(content.validator_set_hash)) {
        return {
            valid: false,
            reason: `block ${block.number} has a malformed validator_set_hash`,
        }
    }
    let localSet: string
    try {
        localSet = await committedValidatorSetHash(prevBlock.number)
    } catch (e) {
        return {
            valid: false,
            reason: `cannot derive the validator set after block ${prevBlock.number}: ${e instanceof Error ? e.message : String(e)}`,
        }
    }
    if (content.validator_set_hash !== localSet) {
        return {
            valid: false,
            reason: `validator_set_hash mismatch: block ${block.number} commits ${content.validator_set_hash}, local set after block ${prevBlock.number} gives ${localSet}`,
        }
    }
    return { valid: true }
}

interface ServedTx {
    hash: string
    status?: unknown
    attrs?: { code?: unknown } | null
}

/**
 * Result root `block` will have once inserted with `txs`: a transaction
 * already on chain keeps its stored row (the insert skips it), every other
 * one is stored as served, with the block's number.
 */
export async function projectedResultsRoot(
    block: { number: number; content: { ordered_transactions?: string[] } },
    txs: ServedTx[],
): Promise<string> {
    const hashes = block.content?.ordered_transactions ?? []
    if (block.number < 1 || hashes.length === 0) return EMPTY_RESULTS_ROOT

    const rows = await readResultRows(hashes)
    for (const tx of txs) {
        if (rows.has(tx.hash)) continue
        rows.set(tx.hash, {
            hash: tx.hash,
            status: tx.status,
            attrs: tx.attrs ?? null,
            blockNumber: block.number,
        })
    }
    return await resultsRoot(hashes, rows, block.number)
}
