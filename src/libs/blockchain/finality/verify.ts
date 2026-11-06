/**
 * Reference offline verifier for finality proofs: what a client holding a
 * trusted validator set checks before it believes a node about the outcome
 * of a transaction or the state of a storage program. Pure functions over
 * the RPC answers; nothing here reads the database or this node's state.
 *
 * A proof is anchored on a signed block whose committee is drawn, by the
 * rules in getShard, from the parent's committed peerlist and the validator
 * set the parent commits (`validator_set_hash` = H(V(parent - 1))). The
 * client must hold that set: when its hash does not match, the answer is
 * "indeterminate" (fetch the set and retry), never a guess. Anything that
 * does not check out is "invalid".
 *
 * The parent comes from the prover, bound to the anchor by previousHash
 * alone, so its peerlist is the prover's choice. It is trusted to narrow the
 * signers only when the client vouches for the parent (`trustedBlockHash`)
 * or names the committee itself; otherwise a quorum must come from a staked
 * set no larger than the shard, where any quorum is 2/3 + 1 of every
 * validator.
 */

import { createPublicKey, verify as ed25519Verify } from "node:crypto"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"
import { isRound, precommitMessage } from "src/libs/consensus/v2/commitLock/messages"
import {
    boundPoolFrom,
    eligiblePoolFrom,
} from "src/libs/consensus/v2/routines/poolRules"
import { jcsCanonicalize } from "src/libs/crypto/jcs"
import { compareCodeUnits } from "src/libs/crypto/canonicalJson"
import { verifyAuditPath } from "src/libs/crypto/merkle/rfc6962"
import {
    verifyMembership,
    verifyNonMembership,
    type SparseTerminal,
} from "src/libs/crypto/merkle/sparse"
import Hashing from "src/libs/crypto/hashing"
import type { ValidatorSetEntry } from "src/model/entities/ValidatorSetSnapshots"
import {
    storageProgramKey,
    storageRecordLeafHex,
    type StorageProgramRecord,
} from "./storageRecord"
import { activeIdentities, validatorSetHash } from "./validatorSetRecord"

export interface BlockBytes {
    number: number
    hash: string
    contentBytes: string
}

export interface SignedHeader extends BlockBytes {
    round: number | null
    signedMessage: string | null
    signatures: Record<string, string>
}

/**
 * The transaction as getTransactionProof serves it: `contentBytes` is the
 * exact text its hash is the sha256 of.
 */
export interface TransactionBytes {
    hash: string
    contentBytes: string
    signature?: { type: string; data: string } | null
    ed25519_signature?: string | null
}

/** getTransactionProof's answer. `tx` is absent from older nodes. */
export interface TransactionProof {
    hash: string
    blockNumber: number
    leafIndex: number
    treeSize: number
    leaf: string
    auditPath: string[]
    committedIn: number
    inclusionBlock: BlockBytes
    commitBlock: SignedHeader
    tx?: TransactionBytes
}

/**
 * What the client expects the transaction to be. Addresses compare without
 * case or 0x; amount and nonce compare as the integers the signed content
 * carries (amount in OS once osDenomination applies, a DEM number before).
 */
export interface ExpectedTransaction {
    from?: string
    to?: string
    amount?: bigint | number | string
    nonce?: bigint | number | string
}

export interface StorageProofEntry {
    storageAddress: string
    record: StorageProgramRecord | null
    siblings: string[]
    terminal: SparseTerminal
}

/** getStorageProof's answer. */
export interface StorageProof {
    anchor: SignedHeader
    anchorParent: BlockBytes
    asOfBlock: number
    proofs: StorageProofEntry[]
}

/** V(parent - 1), as getValidatorSet serves it. */
export interface TrustedValidatorSet {
    validators: ValidatorSetEntry[]
}

export type SignatureCheck = (
    publicKeyHex: string,
    signatureHex: string,
    message: Uint8Array,
) => boolean

export interface CommitteeRules {
    /** The genesis shardSize: the quorum is 2/3 + 1 of it. */
    shardSize: number
    /**
     * Whether the anchor's height is under commitLock (mainnet: from block
     * 0). Signatures then sign the round's precommit message, else the bare
     * hash. Default true.
     */
    commitLock?: boolean
    /**
     * The exact bound committee, for a client that drew it itself. Without
     * it the pool the committee is drawn from must be no larger than
     * `shardSize`, so the committee is the whole pool; a larger pool gives
     * "indeterminate", since signers outside the drawn committee would
     * otherwise count.
     */
    committee?: string[]
    /**
     * The hash of the block at `height` on a chain the client already holds
     * (its own synced chain or a checkpoint), or undefined when it holds
     * none. Without it, or a committee, a staked set larger than the shard
     * gives "indeterminate": a quorum of the shard could otherwise sign a
     * child of a parent it fabricated, with a peerlist of only itself.
     */
    trustedBlockHash?: (height: number) => string | undefined
    /** Ed25519 check; node:crypto by default. */
    verifySignature?: SignatureCheck
}

export type TransactionVerdict =
    | "final-executed"
    | "final-failed"
    | "invalid"
    | "indeterminate"

export interface TransactionVerification {
    verdict: TransactionVerdict
    reason?: string
    /** The signed transaction content, when the proof carries it. */
    content?: Record<string, unknown>
}

export interface StorageVerification {
    verdict: "final" | "invalid" | "indeterminate"
    reason?: string
    asOfBlock?: number
    records?: { storageAddress: string; record: StorageProgramRecord | null }[]
}

const HASH_HEX = /^[0-9a-f]{64}$/
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const utf8 = new TextEncoder()

class Rejection extends Error {
    constructor(
        readonly verdict: "invalid" | "indeterminate",
        reason: string,
    ) {
        super(reason)
    }
}

const invalid = (reason: string) => new Rejection("invalid", reason)

const stripHex = (value: string): string => value.replace(/^0x/i, "").toLowerCase()

export const nodeCryptoSignatureCheck: SignatureCheck = (publicKeyHex, signatureHex, message) => {
    try {
        const raw = Buffer.from(stripHex(publicKeyHex), "hex")
        const signature = Buffer.from(stripHex(signatureHex), "hex")
        if (raw.length !== 32 || signature.length !== 64) return false
        const key = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
            format: "der",
            type: "spki",
        })
        return ed25519Verify(null, message, key, signature)
    } catch {
        return false
    }
}

interface ParsedBlock {
    number: number
    hash: string
    content: Record<string, unknown>
}

/** Checks the hash over the served bytes and reads the content from them. */
function parseBlock(block: BlockBytes | undefined, what: string): ParsedBlock {
    if (!block || typeof block !== "object") throw invalid(`${what} is missing`)
    const { number, hash, contentBytes } = block
    if (!Number.isSafeInteger(number) || number < 0) throw invalid(`${what} has no block number`)
    if (typeof hash !== "string" || !HASH_HEX.test(hash)) throw invalid(`${what} has a malformed hash`)
    if (typeof contentBytes !== "string") throw invalid(`${what} has no content bytes`)
    if (Hashing.sha256(contentBytes) !== hash) {
        throw invalid(`${what} content does not hash to ${hash}`)
    }
    let content: unknown
    try {
        content = JSON.parse(contentBytes)
    } catch {
        throw invalid(`${what} content is not JSON`)
    }
    if (!content || typeof content !== "object" || Array.isArray(content)) {
        throw invalid(`${what} content is not an object`)
    }
    const signed = content as Record<string, unknown>
    // A height outside the hash would let one signed block stand for another.
    if (signed.number !== undefined && signed.number !== number) {
        throw invalid(`${what} is served as ${number} but its content commits ${JSON.stringify(signed.number)}`)
    }
    return { number, hash, content: signed }
}

/** The anchor and its parent: hashes, heights and the link between them. */
function parseAnchor(
    header: SignedHeader | undefined,
    parentBytes: BlockBytes | undefined,
): { anchor: ParsedBlock; parent: ParsedBlock } {
    const anchor = parseBlock(header, `block ${header?.number}`)
    const parent = parseBlock(parentBytes, `block ${parentBytes?.number}`)
    if (anchor.content.number !== anchor.number) {
        throw invalid(`block ${anchor.number} does not commit its own height`)
    }
    if (anchor.number !== parent.number + 1) {
        throw invalid(`block ${anchor.number} is not the child of block ${parent.number}`)
    }
    if (anchor.content.previousHash !== parent.hash) {
        throw invalid(`block ${anchor.number} does not follow block ${parent.number}'s hash`)
    }
    return { anchor, parent }
}

/**
 * Whether the client vouches for `parent`: true when its trusted chain holds
 * the same block, false when it holds none at that height.
 */
function parentIsTrusted(parent: ParsedBlock, rules: CommitteeRules): boolean {
    const held = rules.trustedBlockHash?.(parent.number)
    if (typeof held !== "string") return false
    if (stripHex(held) !== parent.hash) {
        throw invalid(`block ${parent.number} is not the trusted chain's block ${parent.number}`)
    }
    return true
}

/** Identities the anchor's height admits as signers, by the getShard rules. */
function signerPool(
    parent: ParsedBlock,
    trusted: TrustedValidatorSet,
    rules: CommitteeRules,
): Set<string> {
    const trustedParent = parentIsTrusted(parent, rules)
    const committedSet = parent.content.validator_set_hash
    if (typeof committedSet !== "string" || !HASH_HEX.test(committedSet)) {
        throw new Rejection("indeterminate", `block ${parent.number} commits no validator set`)
    }
    if (!trusted || !Array.isArray(trusted.validators)) {
        throw new Rejection("indeterminate", "no trusted validator set")
    }
    let trustedHash: string
    try {
        trustedHash = validatorSetHash(trusted.validators)
    } catch {
        throw new Rejection("indeterminate", "the trusted validator set cannot be hashed")
    }
    if (trustedHash !== committedSet) {
        throw new Rejection(
            "indeterminate",
            `block ${parent.number} commits validator set ${committedSet}, the trusted set is ${trustedHash}`,
        )
    }

    // The set after parent - 1, filtered at that height: what block parent
    // itself could commit to, as getShard reads it.
    const height = Math.max(parent.number - 1, 0)
    const staked = activeIdentities(trusted.validators, height)
    if (staked.size === 0) {
        throw new Rejection("indeterminate", `no active validator at block ${height}`)
    }
    const peerlist = Array.isArray(parent.content.peerlist)
        ? (parent.content.peerlist as unknown[])
              .filter((id): id is string => typeof id === "string" && id.length > 0)
              .map(id => id.toLowerCase())
        : []
    // The record form may carry 0x and a client-drawn committee may not.
    const stakedIds = new Set([...staked].map(stripHex))
    if (rules.committee) {
        return new Set(
            rules.committee
                .filter(id => typeof id === "string")
                .map(stripHex)
                .filter(id => stakedIds.has(id)),
        )
    }
    if (!trustedParent && staked.size > rules.shardSize) {
        throw new Rejection(
            "indeterminate",
            `block ${parent.number} is not on a chain the client holds and ${staked.size} validators are staked, ` +
                `more than the shard size ${rules.shardSize}; supply its hash or the committee drawn for block ${parent.number + 1}`,
        )
    }
    const floor = quorumThreshold(rules.shardSize)
    const eligible = eligiblePoolFrom(peerlist, staked)
    const pool = boundPoolFrom(eligible?.pool ?? [], staked, floor)
    // The committee is the first shardSize of a seeded ranking of the pool;
    // the seed needs blocks this proof does not carry.
    if (pool.length > rules.shardSize) {
        throw new Rejection(
            "indeterminate",
            `the committee for block ${parent.number + 1} is drawn from ${pool.length} identities, ` +
                `more than the shard size ${rules.shardSize}; supply the committee drawn for it`,
        )
    }
    return new Set(pool.map(stripHex))
}

/** The quorum on the anchor: distinct pool members over the recomputed message. */
function checkQuorum(
    header: SignedHeader,
    pool: Set<string>,
    rules: CommitteeRules,
): void {
    let expected: string
    if (rules.commitLock === false) {
        expected = header.hash
    } else {
        if (!isRound(header.round)) throw invalid(`block ${header.number} carries no round`)
        expected = precommitMessage(header.number, header.round, header.hash)
    }
    if (header.signedMessage !== expected) {
        throw invalid(`block ${header.number} serves signedMessage ${JSON.stringify(header.signedMessage)}, expected ${expected}`)
    }
    const signatures = header.signatures
    if (!signatures || typeof signatures !== "object") {
        throw invalid(`block ${header.number} carries no signatures`)
    }

    const check = rules.verifySignature ?? nodeCryptoSignatureCheck
    const message = utf8.encode(expected)
    const signers = new Set<string>()
    for (const [identity, signature] of Object.entries(signatures)) {
        if (typeof signature !== "string") continue
        // One key may be spelled several ways; it still counts once.
        const id = stripHex(identity)
        if (!pool.has(id) || signers.has(id)) continue
        if (check(id, signature, message)) signers.add(id)
    }
    const threshold = quorumThreshold(rules.shardSize)
    if (signers.size < threshold) {
        throw invalid(
            `block ${header.number} has ${signers.size} verified signature(s) from its signer pool of ${pool.size}, needs ${threshold}`,
        )
    }
}

function readLeaf(proof: TransactionProof): { status: "confirmed" | "failed" } {
    let parsed: unknown
    try {
        parsed = JSON.parse(proof.leaf)
    } catch {
        throw invalid("the leaf is not JSON")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalid("the leaf is not an object")
    }
    const leaf = parsed as Record<string, unknown>
    if (Object.keys(leaf).sort(compareCodeUnits).join(",") !== "code,hash,status") {
        throw invalid("the leaf is not {code, hash, status}")
    }
    let canonical: string
    try {
        canonical = jcsCanonicalize(leaf)
    } catch {
        throw invalid("the leaf has no canonical form")
    }
    if (canonical !== proof.leaf) throw invalid("the leaf is not in its canonical encoding")
    if (leaf.hash !== proof.hash) throw invalid("the leaf is for another transaction")
    if (leaf.status === "confirmed" && leaf.code === null) return { status: "confirmed" }
    if (leaf.status === "failed" && (leaf.code === null || typeof leaf.code === "string")) {
        return { status: "failed" }
    }
    throw invalid(`the leaf has status ${JSON.stringify(leaf.status)} with code ${JSON.stringify(leaf.code)}`)
}

/** One canonical spelling of an integer amount or nonce, or null. */
function quantityText(value: unknown): string | null {
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null
        // Past 2^53 the number is no longer the integer that was signed.
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null
        return String(value)
    }
    if (typeof value === "string") {
        const text = value.trim()
        if (/^-?\d+$/.test(text)) return BigInt(text).toString()
        const n = Number(text)
        return text !== "" && Number.isFinite(n) && !Number.isInteger(n) ? String(n) : null
    }
    return null
}

const addressText = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? stripHex(value) : null

const EXPECTED_FIELDS: { field: keyof ExpectedTransaction; read: (value: unknown) => string | null }[] = [
    { field: "from", read: addressText },
    { field: "to", read: addressText },
    { field: "amount", read: quantityText },
    { field: "nonce", read: quantityText },
]

interface NativeSend {
    to: unknown
    amount: unknown
}

/**
 * The send a native transaction makes, or null for any other transaction.
 * Its balance edits are built from `data[1].args`, never from the top-level
 * `to` and `amount`, so a payment is judged by the args.
 */
function nativeSend(content: Record<string, unknown>): NativeSend | null {
    if (content.type !== "native" || !Array.isArray(content.data)) return null
    const payload = content.data[1] as { nativeOperation?: unknown; args?: unknown } | undefined
    if (!payload || typeof payload !== "object" || payload.nativeOperation !== "send") return null
    if (!Array.isArray(payload.args)) throw invalid("the native send carries no args")
    return { to: payload.args[0], amount: payload.args[1] }
}

/** A send whose top-level fields name another payment than it makes is forged. */
function requireTopLevelAgrees(content: Record<string, unknown>, send: NativeSend): void {
    for (const [field, read] of [["to", addressText], ["amount", quantityText]] as const) {
        const top = content[field]
        if (top !== undefined && top !== null && read(top) !== read(send[field])) {
            throw invalid(
                `the transaction's top-level ${field} ${JSON.stringify(top)} is not the ${JSON.stringify(send[field] ?? null)} its send pays`,
            )
        }
    }
}

/**
 * The shipped edits are what apply runs, so the send must carry a balance
 * credit of its amount to its recipient.
 */
function requirePaidEdit(content: Record<string, unknown>, send: NativeSend): void {
    const to = addressText(send.to)
    const amount = quantityText(send.amount)
    const edits = Array.isArray(content.gcr_edits) ? (content.gcr_edits as unknown[]) : []
    const paid = edits.some(raw => {
        const edit = raw as Record<string, unknown> | null
        return (
            !!edit &&
            edit.type === "balance" &&
            edit.operation === "add" &&
            edit.isRollback !== true &&
            to !== null &&
            addressText(edit.account) === to &&
            amount !== null &&
            quantityText(edit.amount) === amount
        )
    })
    if (!paid) {
        throw invalid(`the transaction's balance edits do not credit ${JSON.stringify(send.amount ?? null)} to ${JSON.stringify(send.to ?? null)}`)
    }
}

/**
 * The content of the transaction the proof is about, checked against what
 * the client expects. The hash binds the bytes to the leaf the quorum
 * signed over, so the fields are read from those bytes only. For a native
 * send, `to` and `amount` are the recipient and amount it pays: the top-level
 * fields, where present, must agree with them, and its edits must credit
 * them.
 */
function readContent(
    proof: TransactionProof,
    expected: ExpectedTransaction | undefined,
): Record<string, unknown> | undefined {
    const wanted = EXPECTED_FIELDS.filter(({ field }) => expected?.[field] !== undefined)
    const tx = proof.tx
    if (tx === undefined || tx === null) {
        if (wanted.length === 0) return undefined
        throw new Rejection(
            "indeterminate",
            `the proof carries no transaction content to check ${wanted.map(w => w.field).join(", ")} against`,
        )
    }
    if (typeof tx !== "object" || typeof tx.contentBytes !== "string") {
        throw invalid("the transaction carries no content bytes")
    }
    if (tx.hash !== undefined && (typeof tx.hash !== "string" || stripHex(tx.hash) !== proof.hash)) {
        throw invalid("the transaction served is not the one proven")
    }
    if (Hashing.sha256(tx.contentBytes) !== proof.hash) {
        throw invalid(`the transaction content does not hash to ${proof.hash}`)
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(tx.contentBytes)
    } catch {
        throw invalid("the transaction content is not JSON")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalid("the transaction content is not an object")
    }
    const content = parsed as Record<string, unknown>
    const paymentWanted = wanted.some(({ field }) => field === "to" || field === "amount")
    const send = paymentWanted ? nativeSend(content) : null
    if (send) requireTopLevelAgrees(content, send)
    for (const { field, read } of wanted) {
        const shown = JSON.stringify(String(expected![field]))
        const want = read(expected![field])
        if (want === null) throw invalid(`the expected ${field} ${shown} is not comparable`)
        const actual = send && (field === "to" || field === "amount") ? send[field] : content[field]
        if (read(actual) !== want) {
            throw invalid(`the transaction's ${field} is ${JSON.stringify(actual ?? null)}, expected ${shown}`)
        }
    }
    if (send) requirePaidEdit(content, send)
    return content
}

function run<T extends { verdict: string; reason?: string }>(
    work: () => T,
): T | { verdict: "invalid" | "indeterminate"; reason: string } {
    try {
        return work()
    } catch (error) {
        if (error instanceof Rejection) return { verdict: error.verdict, reason: error.message }
        return { verdict: "invalid", reason: error instanceof Error ? error.message : String(error) }
    }
}

/**
 * Whether `proof` shows its transaction executed or failed in a final block.
 * The tree size is read from block m's signed `ordered_transactions`, never
 * from the prover: an RFC 6962 root does not commit to it.
 *
 * When the proof carries the transaction, its bytes must hash to the proven
 * hash and the verdict returns the content read from them; each field of
 * `expected` must then match it. For a native send, `to` and `amount` are
 * what the send pays (its args, credited by its balance edits); for other
 * types they are the top-level fields. Expecting a field of a proof without
 * the transaction gives "indeterminate".
 */
export function verifyTransactionProof(
    proof: TransactionProof,
    trusted: TrustedValidatorSet,
    rules: CommitteeRules,
    expected?: ExpectedTransaction,
): TransactionVerification {
    return run(() => {
        if (!proof || typeof proof !== "object") throw invalid("no proof")
        if (typeof proof.hash !== "string" || !HASH_HEX.test(proof.hash)) {
            throw invalid("the proof names no transaction hash")
        }
        const m = proof.blockNumber
        if (!Number.isSafeInteger(m) || proof.committedIn !== m + 1) {
            throw invalid("the result of block m must be committed by block m + 1")
        }
        if (proof.inclusionBlock?.number !== m || proof.commitBlock?.number !== m + 1) {
            throw invalid("the served blocks are not m and m + 1")
        }
        const { anchor, parent } = parseAnchor(proof.commitBlock, proof.inclusionBlock)

        const ordered = parent.content.ordered_transactions
        if (!Array.isArray(ordered)) throw invalid(`block ${m} orders no transactions`)
        if (proof.treeSize !== ordered.length) {
            throw invalid(`treeSize ${proof.treeSize} differs from the ${ordered.length} transactions block ${m} orders`)
        }
        if (!Number.isSafeInteger(proof.leafIndex) || ordered[proof.leafIndex] !== proof.hash) {
            throw invalid(`block ${m} does not order ${proof.hash} at index ${proof.leafIndex}`)
        }
        const { status } = readLeaf(proof)

        const resultsRoot = anchor.content.parent_results_root
        if (typeof resultsRoot !== "string" || !HASH_HEX.test(resultsRoot)) {
            throw invalid(`block ${m + 1} commits no results root`)
        }
        if (!verifyAuditPath(utf8.encode(proof.leaf), proof.leafIndex, ordered.length, proof.auditPath, resultsRoot)) {
            throw invalid(`the audit path does not rebuild block ${m + 1}'s parent_results_root`)
        }

        checkQuorum(proof.commitBlock, signerPool(parent, trusted, rules), rules)
        const content = readContent(proof, expected)
        const verdict: TransactionVerdict = status === "confirmed" ? "final-executed" : "final-failed"
        return content ? { verdict, content } : { verdict }
    })
}

/**
 * Whether every entry of `proof` holds against the storage root of a final
 * block. The root covers the state after `asOfBlock`, the anchor's parent.
 * A record is present (possibly `isDeleted`) or null for a program the
 * state does not hold.
 */
export function verifyStorageProof(
    proof: StorageProof,
    trusted: TrustedValidatorSet,
    rules: CommitteeRules,
): StorageVerification {
    return run(() => {
        if (!proof || typeof proof !== "object") throw invalid("no proof")
        const { anchor, parent } = parseAnchor(proof.anchor, proof.anchorParent)
        if (proof.asOfBlock !== parent.number) {
            throw invalid(`asOfBlock ${proof.asOfBlock} is not the anchor's parent ${parent.number}`)
        }
        const hashes = anchor.content.native_tables_hashes as Record<string, unknown> | undefined
        const root = hashes?.native_storage_programs
        if (typeof root !== "string" || !HASH_HEX.test(root)) {
            throw invalid(`block ${anchor.number} commits no storage root`)
        }
        if (!Array.isArray(proof.proofs) || proof.proofs.length === 0) {
            throw invalid("the proof holds no entries")
        }

        const records: { storageAddress: string; record: StorageProgramRecord | null }[] = []
        for (const entry of proof.proofs) {
            const address = entry?.storageAddress
            if (typeof address !== "string" || address.length === 0) {
                throw invalid("an entry names no storage address")
            }
            const key = storageProgramKey(address)
            const path = { siblings: entry.siblings, terminal: entry.terminal }
            if (entry.record === null) {
                if (!verifyNonMembership(key, path, root)) {
                    throw invalid(`${address} is not proven absent`)
                }
            } else {
                if (!entry.record || entry.record.storageAddress !== address) {
                    throw invalid(`the record served for ${address} is for another program`)
                }
                let valueHash: string
                try {
                    valueHash = storageRecordLeafHex(entry.record)
                } catch {
                    throw invalid(`the record served for ${address} has no canonical form`)
                }
                if (!verifyMembership(key, valueHash, path, root)) {
                    throw invalid(`the record served for ${address} is not the one committed`)
                }
            }
            records.push({ storageAddress: address, record: entry.record })
        }

        checkQuorum(proof.anchor, signerPool(parent, trusted, rules), rules)
        return { verdict: "final" as const, asOfBlock: parent.number, records }
    })
}
