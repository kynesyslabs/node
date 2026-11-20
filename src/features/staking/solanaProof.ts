import type {
    Connection,
    ParsedInstruction,
    ParsedTransactionMeta,
    ParsedTransactionWithMeta,
    PartiallyDecodedInstruction,
    TokenBalance,
} from "@solana/web3.js"
import { PublicKey } from "@solana/web3.js"
import type { ValidatorNftProof } from "./types"
import {
    SolanaAbsentError,
    SolanaUnreachableError,
    askEverySolana,
    sharedSolanaRead,
    withSolana,
    type SolanaPoll,
} from "./solanaRpc"

/**
 * Verification of the Solana side of validator gating: the proof a wallet
 * signs to back a seat, the wallet still holding the NFT, and the transfer
 * a challenge cites as evidence that it no longer does.
 *
 * A result is `invalid` only when a healthy endpoint answered and the
 * answer fails a rule. Every transport failure is `unreachable`, so a
 * caller can tell "reject" from "try again".
 */

export type SolanaCheck =
    | { status: "valid"; slot: number }
    | { status: "invalid"; reason: string }
    | { status: "unreachable"; reason: string }

export const MEMO_PROGRAM_IDS = new Set([
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
])

export const PROOF_MEMO_PREFIX = "demos-validator:"

/** Clock skew tolerated between the Solana block time and the Demos tx timestamp. */
export const PROOF_CLOCK_SKEW_SECONDS = 60

/** Oldest a proof may be at stake time. Consensus-relevant: every node holds the same value. */
export const PROOF_MAX_AGE_SECONDS = 86_400

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/

/** What the proof transaction itself says, independent of who stakes with it. */
type InspectedProof =
    | { status: "invalid"; reason: string }
    | { status: "unreachable"; reason: string }
    | { status: "valid"; slot: number; named: string; blockTime: number }

/** Inspections by signature, mint and owner. A verdict is kept for good. */
const proofCache = new Map<string, InspectedProof>()

/** A transport failure or unknown signature is kept this long, so a flood of made-up proofs or a Solana outage does not cost a read at every merge. */
export const UNREACHABLE_CACHE_MS = 60_000
type Unreachable = { status: "unreachable"; reason: string }
const unreachableUntil = new Map<string, { until: number; result: Unreachable }>()

/**
 * Keys are chosen by senders, so each cache holds at most this many, losing
 * its oldest entry past it. Emptying it instead would let a flood of made-up
 * proofs lift every outage mark at once.
 */
export const CACHE_CAP = 10_000

function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
    cache.delete(key)
    while (cache.size >= CACHE_CAP) {
        const oldest = cache.keys().next()
        if (oldest.done) break
        cache.delete(oldest.value)
    }
    cache.set(key, value)
}

/**
 * How a check reads Solana. Admission takes the default and may answer from
 * the unreachable cache. The merge and the block-building re-judge pass
 * `fresh`: a cached outage there would keep one member refusing a seat its
 * peers already read as recovered, and the members would build different
 * blocks for up to UNREACHABLE_CACHE_MS. A fresh read still records an
 * outage it meets, so admission stays throttled.
 */
export interface SolanaReadOptions {
    fresh?: boolean
}

function recentlyUnreachable(key: string, options: SolanaReadOptions): Unreachable | null {
    if (options.fresh) return null
    const recent = unreachableUntil.get(key)
    return recent !== undefined && recent.until > Date.now() ? recent.result : null
}

function markUnreachable(key: string, result: Unreachable): Unreachable {
    remember(unreachableUntil, key, { until: Date.now() + UNREACHABLE_CACHE_MS, result })
    return result
}

/** An answer came back, so admission need not wait out an outage already over. */
function answered(key: string): void {
    unreachableUntil.delete(key)
}

export function resetSolanaProofCacheForTesting(): void {
    proofCache.clear()
    unreachableUntil.clear()
}

function invalid(reason: string): { status: "invalid"; reason: string } {
    return { status: "invalid", reason }
}

function unreachable(e: unknown): Unreachable {
    return {
        status: "unreachable",
        reason: e instanceof Error ? e.message : String(e),
    }
}

/** The memo text of a parsed instruction from the Memo program, or null. */
function memoOf(
    instruction: ParsedInstruction | PartiallyDecodedInstruction,
): string | null {
    if (!MEMO_PROGRAM_IDS.has(instruction.programId.toBase58())) return null
    const parsed = (instruction as ParsedInstruction).parsed
    return typeof parsed === "string" ? parsed : null
}

/** The memos in a transaction's top-level instructions, in order. */
export function memosOf(tx: ParsedTransactionWithMeta): string[] {
    const memos: string[] = []
    for (const instruction of tx.transaction.message.instructions) {
        const memo = memoOf(instruction)
        if (memo !== null) memos.push(memo)
    }
    return memos
}

/** Whether `owner` signed the transaction. */
export function signedBy(tx: ParsedTransactionWithMeta, owner: string): boolean {
    return tx.transaction.message.accountKeys.some(
        key => key.signer && key.pubkey.toBase58() === owner,
    )
}

/** The raw amount of `mint` held by `owner` across its token accounts in a balance list, "0" when absent. */
export function balanceOf(
    balances: TokenBalance[] | null | undefined,
    mint: string,
    owner: string,
): string {
    let total = 0n
    for (const balance of balances ?? []) {
        if (balance.mint === mint && balance.owner === owner) {
            total += BigInt(balance.uiTokenAmount.amount)
        }
    }
    return total.toString()
}

/** A finalized transaction with everything the rules below read from it. */
type FullTransaction = ParsedTransactionWithMeta & {
    meta: ParsedTransactionMeta & { preTokenBalances: TokenBalance[]; postTokenBalances: TokenBalance[] }
    blockTime: number
}

async function fetchParsed(signature: string, what: string): Promise<FullTransaction> {
    // An endpoint with pruned history answers null, or the transaction
    // without its metadata, balances or block time. That is no answer: the
    // next endpoint is asked, and if none has it the read is unreachable
    // rather than a refusal another node, asking a fuller endpoint, would
    // not give.
    return sharedSolanaRead(`tx:${signature}`, () =>
        withSolana(what, async (connection: Connection): Promise<FullTransaction> => {
            const tx = await connection.getParsedTransaction(signature, {
                commitment: "finalized",
                maxSupportedTransactionVersion: 0,
            })
            if (tx === null) throw new SolanaAbsentError("not found")
            if (
                !tx.meta ||
                !Array.isArray(tx.meta.preTokenBalances) ||
                !Array.isArray(tx.meta.postTokenBalances) ||
                typeof tx.blockTime !== "number"
            ) {
                throw new SolanaAbsentError("answered without metadata, token balances or block time")
            }
            return tx as FullTransaction
        }),
    )
}

/**
 * Check a stake's NFT proof against the chain. `validatorAddress` is the
 * Demos address the memo must name; `txTimestampMs` is the stake tx's
 * signed timestamp, which bounds the proof's age by `maxAgeSeconds`.
 */
export async function verifyNftProof(
    proof: ValidatorNftProof,
    validatorAddress: string,
    txTimestampMs: number,
    maxAgeSeconds: number = PROOF_MAX_AGE_SECONDS,
    options: SolanaReadOptions = {},
): Promise<SolanaCheck> {
    for (const key of ["mint", "owner", "proofTx"] as const) {
        if (!BASE58.test(proof[key])) return invalid(`nft.${key} is not base58`)
    }
    const cacheKey = `${proof.proofTx}:${proof.mint}:${proof.owner}`
    const cached = proofCache.get(cacheKey)
    if (cached === undefined) {
        const recent = recentlyUnreachable(cacheKey, options)
        if (recent !== null) return recent
    }
    const inspected = cached ?? (await inspectProof(proof))
    if (inspected.status === "unreachable") return markUnreachable(cacheKey, inspected)
    if (cached === undefined) {
        answered(cacheKey)
        remember(proofCache, cacheKey, inspected)
    }
    if (inspected.status === "invalid") return inspected

    const expected = validatorAddress.toLowerCase()
    if (inspected.named !== (expected.startsWith("0x") ? expected : `0x${expected}`)) {
        return invalid(`proof memo names ${inspected.named}, not ${validatorAddress}`)
    }
    const txSeconds = Math.floor(txTimestampMs / 1000)
    const maxAge = maxAgeSeconds
    if (inspected.blockTime > txSeconds + PROOF_CLOCK_SKEW_SECONDS) {
        return invalid("proof is later than the stake transaction")
    }
    if (txSeconds - inspected.blockTime > maxAge) {
        return invalid(`proof is older than ${maxAge}s`)
    }
    return { status: "valid", slot: inspected.slot }
}

/** The rules on the proof transaction itself, independent of who stakes with it. */
async function inspectProof(proof: ValidatorNftProof): Promise<InspectedProof> {
    let tx: FullTransaction
    try {
        tx = await fetchParsed(proof.proofTx, "getParsedTransaction(proof)")
    } catch (e) {
        return unreachable(e)
    }
    if (tx.meta.err !== null) return invalid("proof transaction failed on Solana")
    if (!signedBy(tx, proof.owner)) return invalid("proof is not signed by nft.owner")
    if (balanceOf(tx.meta.postTokenBalances, proof.mint, proof.owner) !== "1") {
        return invalid("proof does not leave the NFT with nft.owner")
    }
    const memos = memosOf(tx).filter(m => m.startsWith(PROOF_MEMO_PREFIX))
    if (memos.length !== 1) return invalid("proof must carry exactly one demos-validator memo")
    const named = memos[0].slice(PROOF_MEMO_PREFIX.length).trim().toLowerCase()
    if (!/^(0x)?[0-9a-f]{64}$/.test(named)) {
        return invalid("proof memo does not name a Demos address")
    }
    return {
        status: "valid",
        slot: tx.slot,
        named: named.startsWith("0x") ? named : `0x${named}`,
        blockTime: tx.blockTime,
    }
}

type TokenAccounts = Awaited<ReturnType<Connection["getParsedTokenAccountsByOwner"]>>

function holdsOne(accounts: TokenAccounts): boolean {
    return accounts.value.some(account => {
        const info = account.account.data.parsed?.info as
            | { tokenAmount?: { amount?: string } }
            | undefined
        return info?.tokenAmount?.amount === "1"
    })
}

/**
 * Whether `owner` holds `mint` now, at finalized commitment. Every endpoint
 * is asked: a lagging or pruned one answers an empty account list, and
 * taking that first answer as "no longer holds" would refuse a seat that
 * nodes with other endpoints accept. So the verdict is valid or invalid
 * only when every endpoint that answered agrees, and invalid also needs at
 * least two answers (one when one endpoint is configured); anything else is
 * unreachable and judged again later.
 */
export async function verifyCurrentOwner(
    mint: string,
    owner: string,
    options: SolanaReadOptions = {},
): Promise<SolanaCheck> {
    const key = `owner:${mint}:${owner}`
    const recent = recentlyUnreachable(key, options)
    if (recent !== null) return recent
    let poll: SolanaPoll<TokenAccounts>
    try {
        poll = await sharedSolanaRead(key, async () => {
            const asked = await askEverySolana("getParsedTokenAccountsByOwner", connection =>
                connection.getParsedTokenAccountsByOwner(
                    new PublicKey(owner),
                    { mint: new PublicKey(mint) },
                    "finalized",
                ),
            )
            // Nothing answered: a transport failure, not shared past this read.
            if (asked.answers.length === 0) {
                throw new SolanaUnreachableError(
                    `getParsedTokenAccountsByOwner: ${asked.failures.join("; ")}`,
                )
            }
            return asked
        })
    } catch (e) {
        return markUnreachable(key, unreachable(e))
    }
    const holding = poll.answers.map(holdsOne)
    if (holding.every(Boolean)) {
        answered(key)
        return { status: "valid", slot: Math.max(...poll.answers.map(a => a.context.slot)) }
    }
    const needed = Math.min(2, poll.endpoints)
    if (holding.every(held => !held) && poll.answers.length >= needed) {
        answered(key)
        return invalid("nft.owner no longer holds the NFT")
    }
    const why = holding.some(Boolean)
        ? `endpoints disagree on whether nft.owner holds the NFT (${holding.filter(Boolean).length} of ${holding.length} say it does)`
        : `only ${poll.answers.length} of ${poll.endpoints} endpoints answered that nft.owner no longer holds the NFT; ${needed} must agree`
    return markUnreachable(key, { status: "unreachable", reason: why })
}

/**
 * Check that `evidenceTx` moved `mint` out of `owner` after the proof.
 * The proof's slot is read from the chain so the comparison does not
 * depend on anything the challenger claims.
 */
export async function verifyChallengeEvidence(
    evidenceTx: string,
    recorded: ValidatorNftProof,
    options: SolanaReadOptions = {},
): Promise<SolanaCheck> {
    if (!BASE58.test(evidenceTx)) return invalid("evidenceTx is not base58")
    const key = `evidence:${evidenceTx}:${recorded.proofTx}`
    const recent = recentlyUnreachable(key, options)
    if (recent !== null) return recent
    let proof: FullTransaction
    let evidence: FullTransaction
    try {
        proof = await fetchParsed(recorded.proofTx, "getParsedTransaction(proof)")
        evidence = await fetchParsed(evidenceTx, "getParsedTransaction(evidence)")
    } catch (e) {
        return markUnreachable(key, unreachable(e))
    }
    answered(key)
    if (evidence.meta.err !== null) return invalid("evidence transaction failed on Solana")
    if (evidence.slot <= proof.slot) return invalid("evidence is not later than the proof")
    const before = balanceOf(evidence.meta.preTokenBalances, recorded.mint, recorded.owner)
    const after = balanceOf(evidence.meta.postTokenBalances, recorded.mint, recorded.owner)
    if (before !== "1" || after !== "0") {
        return invalid("evidence does not move the NFT out of the recorded owner")
    }
    return { status: "valid", slot: evidence.slot }
}

/**
 * Check that a proof at `newSlot` is later on Solana than the proof a seat
 * was taken with, so a fresh binding evicts the seat and a stale one cannot.
 */
export async function verifyProofSupersedes(
    newSlot: number,
    recordedProofTx: string,
    options: SolanaReadOptions = {},
): Promise<SolanaCheck> {
    if (!BASE58.test(recordedProofTx)) return invalid("recorded proof is not base58")
    const key = `supersedes:${recordedProofTx}`
    const recent = recentlyUnreachable(key, options)
    if (recent !== null) return recent
    let recorded: FullTransaction
    try {
        recorded = await fetchParsed(recordedProofTx, "getParsedTransaction(recorded proof)")
    } catch (e) {
        return markUnreachable(key, unreachable(e))
    }
    answered(key)
    if (newSlot <= recorded.slot) {
        return invalid(`proof at slot ${newSlot} is not later than the seat's proof at slot ${recorded.slot}`)
    }
    return { status: "valid", slot: newSlot }
}

export { SolanaUnreachableError }
