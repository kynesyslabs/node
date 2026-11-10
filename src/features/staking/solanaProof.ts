import type {
    Connection,
    ParsedInstruction,
    ParsedTransactionWithMeta,
    PartiallyDecodedInstruction,
    TokenBalance,
} from "@solana/web3.js"
import { PublicKey } from "@solana/web3.js"
import type { ValidatorNftProof } from "@kynesyslabs/demosdk/types"
import { SolanaUnreachableError, withSolana } from "./solanaRpc"

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
    | { status: "valid"; slot: number; named: string; blockTime: number | null }

/** Inspections by signature, mint and owner; transport failures are never cached. */
const proofCache = new Map<string, InspectedProof>()

export function resetSolanaProofCacheForTesting(): void {
    proofCache.clear()
}

function invalid(reason: string): { status: "invalid"; reason: string } {
    return { status: "invalid", reason }
}

function unreachable(e: unknown): { status: "unreachable"; reason: string } {
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

/** The raw amount of `mint` held by `owner` in a balance list, "0" when absent. */
export function balanceOf(
    balances: TokenBalance[] | null | undefined,
    mint: string,
    owner: string,
): string {
    for (const balance of balances ?? []) {
        if (balance.mint === mint && balance.owner === owner) {
            return balance.uiTokenAmount.amount
        }
    }
    return "0"
}

async function fetchParsed(
    signature: string,
    what: string,
): Promise<ParsedTransactionWithMeta> {
    // An endpoint with pruned history answers null; the next one is asked.
    return withSolana(what, async (connection: Connection) => {
        const tx = await connection.getParsedTransaction(signature, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
        })
        if (tx === null) throw new Error("not found")
        return tx
    }
    )
}

/**
 * Check a stake's NFT proof against the chain. `validatorAddress` is the
 * Demos address the memo must name; `txTimestampMs` is the stake tx's
 * signed timestamp, which bounds the proof's age.
 */
export async function verifyNftProof(
    proof: ValidatorNftProof,
    validatorAddress: string,
    txTimestampMs: number,
): Promise<SolanaCheck> {
    for (const key of ["mint", "owner", "proofTx"] as const) {
        if (!BASE58.test(proof[key])) return invalid(`nft.${key} is not base58`)
    }
    const cacheKey = `${proof.proofTx}:${proof.mint}:${proof.owner}`
    const cached = proofCache.get(cacheKey)
    const inspected = cached ?? (await inspectProof(proof))
    if (inspected.status === "unreachable") return inspected
    if (cached === undefined) proofCache.set(cacheKey, inspected)
    if (inspected.status === "invalid") return inspected

    const expected = validatorAddress.toLowerCase()
    if (inspected.named !== (expected.startsWith("0x") ? expected : `0x${expected}`)) {
        return invalid(`proof memo names ${inspected.named}, not ${validatorAddress}`)
    }
    if (inspected.blockTime === null) return invalid("proof has no block time")
    const txSeconds = Math.floor(txTimestampMs / 1000)
    const maxAge = PROOF_MAX_AGE_SECONDS
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
    let tx: ParsedTransactionWithMeta
    try {
        tx = await fetchParsed(proof.proofTx, "getParsedTransaction(proof)")
    } catch (e) {
        return unreachable(e)
    }
    if (tx.meta === null || tx.meta === undefined) return invalid("proof has no metadata")
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
        blockTime: typeof tx.blockTime === "number" ? tx.blockTime : null,
    }
}

/** Whether `owner` holds `mint` now, at finalized commitment. */
export async function verifyCurrentOwner(
    mint: string,
    owner: string,
): Promise<SolanaCheck> {
    try {
        const accounts = await withSolana("getParsedTokenAccountsByOwner", connection =>
            connection.getParsedTokenAccountsByOwner(
                new PublicKey(owner),
                { mint: new PublicKey(mint) },
                "finalized",
            ),
        )
        const held = accounts.value.some(account => {
            const info = account.account.data.parsed?.info as
                | { tokenAmount?: { amount?: string } }
                | undefined
            return info?.tokenAmount?.amount === "1"
        })
        return held
            ? { status: "valid", slot: accounts.context.slot }
            : invalid("nft.owner no longer holds the NFT")
    } catch (e) {
        return unreachable(e)
    }
}

/**
 * Check that `evidenceTx` moved `mint` out of `owner` after the proof.
 * The proof's slot is read from the chain so the comparison does not
 * depend on anything the challenger claims.
 */
export async function verifyChallengeEvidence(
    evidenceTx: string,
    recorded: ValidatorNftProof,
): Promise<SolanaCheck> {
    if (!BASE58.test(evidenceTx)) return invalid("evidenceTx is not base58")
    let proof: ParsedTransactionWithMeta
    let evidence: ParsedTransactionWithMeta
    try {
        proof = await fetchParsed(recorded.proofTx, "getParsedTransaction(proof)")
        evidence = await fetchParsed(evidenceTx, "getParsedTransaction(evidence)")
    } catch (e) {
        return unreachable(e)
    }
    if (evidence.meta === null || evidence.meta === undefined) {
        return invalid("evidence has no metadata")
    }
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
): Promise<SolanaCheck> {
    if (!BASE58.test(recordedProofTx)) return invalid("recorded proof is not base58")
    let recorded: ParsedTransactionWithMeta
    try {
        recorded = await fetchParsed(recordedProofTx, "getParsedTransaction(recorded proof)")
    } catch (e) {
        return unreachable(e)
    }
    if (newSlot <= recorded.slot) {
        return invalid(`proof at slot ${newSlot} is not later than the seat's proof at slot ${recorded.slot}`)
    }
    return { status: "valid", slot: newSlot }
}

export { SolanaUnreachableError }
