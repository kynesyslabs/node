/**
 * Node-side checks of an `l2psBatch` settlement record, shared by block apply
 * (forge, block validation and Sync go through HandleGCR.applyTransactions),
 * forge selection and the member's admission and aggregation.
 * Spec: docs/design/l2ps-zk-settlement.md, "Interface v1".
 *
 * Every check here returns a refusal instead of throwing, and depends only on
 * the transaction, the chain id, the network fee parameters and the working
 * state handed in, so every node reaches the same verdict on the same block.
 */
import type { GCREdit } from "@kynesyslabs/demosdk/types"
import type { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { generateFeeDistributionEdits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"
import { calculateFeeBreakdown } from "@/libs/blockchain/routines/calculateCurrentGas"
import { getSharedState } from "@/utilities/sharedState"
import {
    AMOUNT_LIMIT,
    NONCE_LIMIT,
    SETTLEMENT_ACCOUNTS,
    SETTLEMENT_TRANSFERS,
    SETTLEMENT_VERSION,
    compareAccounts,
    hexToField,
    parseDelta,
    parseUnsigned,
    settlementPublicSignals,
    settlementSignatureMessage,
    SettlementEncodingError,
    type PublicAccount,
    type PublicTransfer,
} from "./encoding"
import { verifySettlementProof } from "./prover"
import { verifyEd25519 } from "./ed25519"
import type { SettlementChange, SettlementProof } from "./types"

/** Proof checks per block stay within about a second of block validation. */
export const MAX_SETTLEMENT_BATCHES_PER_BLOCK = 20

/** BN254 scalar field: a commitment at or above it aliases a smaller one. */
const FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n

const ACCOUNT = /^0x[0-9a-f]{64}$/
const FIELD_HEX = /^0x[0-9a-f]{64}$/
const SIGNATURE_HEX = /^0x[0-9a-f]{128}$/

/** Wire shape of one transfer in `data[1].settlement.transfers`. */
export interface SettlementTransferRecord {
    commitment: string
    signer: string
    nonce: string
    fee: string
    signature: string
}

/** Wire shape of one change in `data[1].settlement.changes`. */
export interface SettlementChangeRecord {
    account: string
    delta: string
}

/** The `settlement` field of an `l2psBatch` payload, inside its signed content. */
export interface SettlementRecord {
    version: typeof SETTLEMENT_VERSION
    transfers: SettlementTransferRecord[]
    changes: SettlementChangeRecord[]
    proof: SettlementProof
}

export interface SettlementTransfer extends PublicTransfer {
    signature: string
}

/** A settlement record that passed the structural checks, as integers. */
export interface ParsedSettlement {
    l2psUid: string
    transfers: SettlementTransfer[]
    changes: SettlementChange[]
    proof: SettlementProof
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string }

const refuse = <T>(reason: string): Verdict<T> => ({ ok: false, reason })

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Structure and limits of a batch's settlement record, checked on the raw
 * strings before any of them becomes an integer or a field element.
 *
 * Beyond Interface v1 this also requires `sum(delta) = -sum(fee)`, which the
 * circuit enforces for every valid proof, so it never refuses a batch a proof
 * could pass; and a fee no larger than Number.MAX_SAFE_INTEGER, because the
 * fee distribution edits are computed in JS numbers and must split exactly.
 */
export function parseSettlement(tx: {
    content?: { type?: unknown; data?: unknown }
}): Verdict<ParsedSettlement> {
    const data = tx?.content?.data
    if (tx?.content?.type !== "l2psBatch" || !Array.isArray(data) || data[0] !== "l2psBatch") {
        return refuse("not an l2psBatch transaction")
    }
    const payload = data[1]
    if (!isPlainObject(payload)) return refuse("l2psBatch payload is not an object")
    const l2psUid = payload.l2ps_uid
    if (typeof l2psUid !== "string" || l2psUid.length === 0 || l2psUid.includes(":")) {
        return refuse("l2psBatch payload has no valid l2ps_uid")
    }
    const record = payload.settlement
    if (!isPlainObject(record)) {
        return refuse("l2psBatch carries no settlement record (old format)")
    }
    if (record.version !== SETTLEMENT_VERSION) {
        return refuse(`unsupported settlement version ${String(record.version)}`)
    }
    const { transfers, changes, proof } = record
    if (!Array.isArray(transfers) || transfers.length === 0 || transfers.length > SETTLEMENT_TRANSFERS) {
        return refuse(`settlement must carry 1..${SETTLEMENT_TRANSFERS} transfers`)
    }
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > SETTLEMENT_ACCOUNTS) {
        return refuse(`settlement must carry 1..${SETTLEMENT_ACCOUNTS} changes`)
    }
    if (!isPlainObject(proof)) return refuse("settlement proof is not an object")

    for (const [i, t] of transfers.entries()) {
        if (!isPlainObject(t)) return refuse(`transfer ${i} is not an object`)
        if (typeof t.commitment !== "string" || !FIELD_HEX.test(t.commitment)) {
            return refuse(`transfer ${i} commitment is not 32-byte lowercase hex`)
        }
        if (typeof t.signer !== "string" || !ACCOUNT.test(t.signer)) {
            return refuse(`transfer ${i} signer is not a canonical account`)
        }
        if (typeof t.signature !== "string" || !SIGNATURE_HEX.test(t.signature)) {
            return refuse(`transfer ${i} signature is not 64-byte lowercase hex`)
        }
        if (typeof t.nonce !== "string" || typeof t.fee !== "string") {
            return refuse(`transfer ${i} nonce and fee must be decimal strings`)
        }
    }
    for (const [i, c] of changes.entries()) {
        if (!isPlainObject(c)) return refuse(`change ${i} is not an object`)
        if (typeof c.account !== "string" || !ACCOUNT.test(c.account)) {
            return refuse(`change ${i} account is not a canonical account`)
        }
        if (typeof c.delta !== "string") return refuse(`change ${i} delta is not a string`)
        if (i > 0 && compareAccounts((changes[i - 1] as SettlementChangeRecord).account, c.account) >= 0) {
            return refuse("changes are not sorted by account or repeat one")
        }
    }

    const parsedTransfers: SettlementTransfer[] = []
    const parsedChanges: SettlementChange[] = []
    try {
        for (const [i, t] of (transfers as SettlementTransferRecord[]).entries()) {
            const commitment = hexToField(t.commitment)
            if (commitment >= FIELD_MODULUS) {
                return refuse(`transfer ${i} commitment is not a field element`)
            }
            const fee = parseUnsigned(t.fee, AMOUNT_LIMIT, `transfer ${i} fee`)
            if (fee > BigInt(Number.MAX_SAFE_INTEGER)) {
                return refuse(`transfer ${i} fee is above ${Number.MAX_SAFE_INTEGER}`)
            }
            parsedTransfers.push({
                commitment,
                signer: t.signer,
                nonce: parseUnsigned(t.nonce, NONCE_LIMIT, `transfer ${i} nonce`),
                fee,
                signature: t.signature,
            })
        }
        for (const c of changes as SettlementChangeRecord[]) {
            parsedChanges.push({ account: c.account, delta: parseDelta(c.delta) })
        }
    } catch (error) {
        if (error instanceof SettlementEncodingError) return refuse(error.message)
        throw error
    }

    const named = new Set(parsedChanges.map(c => c.account))
    for (const t of parsedTransfers) {
        if (!named.has(t.signer)) return refuse(`signer ${t.signer} is not named in changes`)
    }
    const deltaSum = parsedChanges.reduce((sum, c) => sum + c.delta, 0n)
    const feeSum = parsedTransfers.reduce((sum, t) => sum + t.fee, 0n)
    if (deltaSum !== -feeSum) {
        return refuse("changes do not sum to minus the fees")
    }

    return {
        ok: true,
        value: {
            l2psUid,
            transfers: parsedTransfers,
            changes: parsedChanges,
            proof: proof as SettlementProof,
        },
    }
}

export { verifyEd25519 }

/** Why a transfer's signature does not hold, or null. */
export function settlementSignatureRefusal(
    settlement: ParsedSettlement,
    chainId: number | null,
): string | null {
    if (chainId === null) return "the chain declares no id to bind settlement signatures to"
    for (const [i, t] of settlement.transfers.entries()) {
        let message: Uint8Array
        try {
            message = settlementSignatureMessage(chainId, settlement.l2psUid, t.commitment)
        } catch (error) {
            return `transfer ${i}: ${(error as Error).message}`
        }
        if (!verifyEd25519(message, t.signature, t.signer)) {
            return `transfer ${i} signature does not verify for ${t.signer}`
        }
    }
    return null
}

/**
 * The fee a native transfer pays now, in OS: the components feeBinding binds a
 * native transaction's shipped fee to, from the network parameters.
 */
export async function nativeTransferFeeOs(): Promise<bigint> {
    const breakdown = await calculateFeeBreakdown(null)
    let total = 0n
    for (const component of [breakdown.network_fee, breakdown.rpc_fee, breakdown.additional_fee]) {
        total += BigInt(component) * 1_000_000_000n
    }
    return total
}

export function settlementFeeRefusal(settlement: ParsedSettlement, minimumFee: bigint): string | null {
    for (const [i, t] of settlement.transfers.entries()) {
        if (t.fee < minimumFee) {
            return `transfer ${i} fee ${t.fee} is below the native transfer fee ${minimumFee}`
        }
    }
    return null
}

/**
 * Each signer's transfers carry consecutive nonces from its account nonce + 1,
 * in batch order. `nonceOf` reads the working state at this transaction.
 */
export function settlementNonceRefusal(
    settlement: ParsedSettlement,
    nonceOf: (account: string) => bigint,
): string | null {
    const next = new Map<string, bigint>()
    for (const [i, t] of settlement.transfers.entries()) {
        const expected = next.get(t.signer) ?? nonceOf(t.signer) + 1n
        if (t.nonce !== expected) {
            return `transfer ${i} nonce ${t.nonce} is not ${t.signer}'s next nonce ${expected}`
        }
        next.set(t.signer, expected + 1n)
    }
    return null
}

/** Transfers per signer: the amount each signer's nonce moves by. */
export function settlementNonceSpend(settlement: ParsedSettlement): Map<string, number> {
    const spend = new Map<string, number>()
    for (const t of settlement.transfers) spend.set(t.signer, (spend.get(t.signer) ?? 0) + 1)
    return spend
}

/**
 * Public signals rebuilt from the transaction and the working state, and the
 * PLONK proof checked against them. Only a false verdict refuses the batch:
 * it is the same on every honest node. A verifier that throws could not judge
 * (a missing key, a failed curve build, no memory), so the error leaves the
 * block apply and this node halts instead of failing a batch its peers apply.
 */
export async function settlementProofRefusal(
    settlement: ParsedSettlement,
    balanceOf: (account: string) => bigint,
): Promise<string | null> {
    let signals: bigint[]
    try {
        const accounts: PublicAccount[] = settlement.changes.map(c => ({
            account: c.account,
            balanceBefore: balanceOf(c.account),
            delta: c.delta,
        }))
        signals = settlementPublicSignals(
            settlement.transfers.map(({ commitment, signer, nonce, fee }) => ({
                commitment,
                signer,
                nonce,
                fee,
            })),
            accounts,
        )
    } catch (error) {
        return `public signals: ${(error as Error).message}`
    }
    const valid = await verifySettlementProof(signals, settlement.proof)
    return valid === true ? null : "settlement proof does not verify"
}

/**
 * The working-state checks of Interface v1 step 2 (nonces) and 3 (proof), on
 * the accounts the block's earlier transactions left. Accounts missing from
 * the caches read as a fresh account: nonce 0, balance 0.
 */
export async function settlementStateRefusal(
    settlement: ParsedSettlement,
    accounts: Map<string, GCRMain>,
): Promise<string | null> {
    const nonceRefusal = settlementNonceRefusal(settlement, account =>
        BigInt(accounts.get(account)?.nonce ?? 0),
    )
    if (nonceRefusal) return nonceRefusal
    return settlementProofRefusal(settlement, account =>
        BigInt(accounts.get(account)?.balance ?? 0n),
    )
}

/**
 * The edits a valid settlement applies: each change as a balance edit, each
 * signer's nonce moved by its transfer count, and each fee's distribution
 * credits without the sender debit, which the signer's delta already holds.
 * Derived from the transaction alone, so rollback derives the same edits.
 */
export function settlementEdits(settlement: ParsedSettlement, txHash: string): GCREdit[] {
    const edits: GCREdit[] = []
    for (const c of settlement.changes) {
        if (c.delta === 0n) continue
        edits.push({
            type: "balance",
            operation: c.delta > 0n ? "add" : "remove",
            account: c.account,
            amount: (c.delta > 0n ? c.delta : -c.delta).toString(),
            txhash: txHash,
            isRollback: false,
        } as unknown as GCREdit)
    }
    const spend = [...settlementNonceSpend(settlement)].sort(([a], [b]) => compareAccounts(a, b))
    for (const [account, count] of spend) {
        edits.push({
            type: "nonce",
            operation: "add",
            account,
            amount: count,
            txhash: txHash,
            isRollback: false,
        } as GCREdit)
    }
    edits.push(...settlementFeeCredits(settlement, txHash))
    return edits
}

/** Each fee's distribution credits, without the sender debit the signer's delta holds. */
function settlementFeeCredits(settlement: ParsedSettlement, txHash: string): GCREdit[] {
    const credits: GCREdit[] = []
    for (const t of settlement.transfers) {
        if (t.fee === 0n) continue
        const distribution = generateFeeDistributionEdits({
            senderAddress: t.signer,
            rpcAddress: null,
            networkFee: Number(t.fee),
            rpcFee: 0,
            additionalFee: 0,
            txHash,
            isRollback: false,
        })
        credits.push(...(distribution.filter(e => e.operation === "add") as GCREdit[]))
    }
    return credits
}

/**
 * The signers' deltas debit every fee, so credits that fall short of the fees
 * (no distribution loaded, or all of its shares zero) would burn the rest
 * without a trace.
 */
export function settlementFeeCreditRefusal(settlement: ParsedSettlement): string | null {
    const fees = settlement.transfers.reduce((sum, t) => sum + t.fee, 0n)
    const credited = settlementFeeCredits(settlement, "").reduce(
        (sum, e) => sum + BigInt((e as unknown as { amount: number | string }).amount),
        0n,
    )
    return credited === fees ? null : `fee credits ${credited} do not add up to the fees ${fees}`
}

/**
 * The batches a block may settle: the first MAX_SETTLEMENT_BATCHES_PER_BLOCK
 * `l2psBatch` transactions in the order given, which every caller passes in
 * canonical order. The rest are left out by forging and failed by apply.
 */
export function settlementBatchesOverCap<T extends { hash: string; content: { type?: unknown } }>(
    ordered: readonly T[],
): Set<string> {
    const over = new Set<string>()
    let seen = 0
    for (const tx of ordered) {
        if (tx.content?.type !== "l2psBatch") continue
        seen++
        if (seen > MAX_SETTLEMENT_BATCHES_PER_BLOCK) over.add(tx.hash)
    }
    return over
}

/** The chain id settlement signatures bind to, as the transaction signature domain reads it. */
export function settlementChainId(): number | null {
    return getSharedState.chainId ?? null
}
