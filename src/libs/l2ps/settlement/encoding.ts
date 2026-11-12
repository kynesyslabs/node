/**
 * L2PS settlement v1 encoding, shared by the circuit input builder, the
 * aggregator and block validation. The SDK mirrors commitment and message
 * byte for byte; `__fixtures__/settlementVectors.json` pins both sides.
 * Spec: docs/design/l2ps-zk-settlement.md, "Interface v1" and "Interface v1.1".
 */
import * as poseidon from "poseidon-lite"

/**
 * Transfer slots per batch proof: the most that keep the circuit within 2^16
 * PLONK constraints. Changing it means rebuilding the circuit and its key.
 */
export const SETTLEMENT_TRANSFERS = 9
/** Account slots per batch proof: a sender and a receiver per transfer. */
export const SETTLEMENT_ACCOUNTS = 2 * SETTLEMENT_TRANSFERS
export const SETTLEMENT_VERSION = 1
export const SETTLEMENT_SIGNATURE_DOMAIN = "l2ps-settlement:v1:"

/** Amounts, fees, balances and net change magnitudes stay below this. */
export const AMOUNT_LIMIT = 1n << 128n
export const NONCE_LIMIT = 1n << 64n
export const SALT_BYTES = 31
/** BN254 scalar field order: circuit values and hashes live below it. */
export const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

type PoseidonHash = (inputs: bigint[]) => bigint
// Poseidon with exactly N inputs; poseidon-lite (like circomlib) stops at 16.
const poseidonOfArity = (n: number): PoseidonHash => {
    const hash = (poseidon as unknown as Record<string, PoseidonHash | undefined>)[`poseidon${n}`]
    if (hash === undefined) throw new Error(`no Poseidon with ${n} inputs`)
    return hash
}
const poseidon8 = poseidonOfArity(8)
const slotsHash = poseidonOfArity(SETTLEMENT_TRANSFERS)

const ACCOUNT = /^0x[0-9a-f]{64}$/
const FIELD_HEX = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const SIGNED_DECIMAL = /^(0|-?[1-9][0-9]*)$/

export class SettlementEncodingError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SettlementEncodingError"
    }
}

/** A 32-byte account does not fit one BN254 element: two 128-bit limbs. */
export function accountLimbs(account: string): [bigint, bigint] {
    if (!ACCOUNT.test(account)) {
        throw new SettlementEncodingError(`not a canonical account: ${account}`)
    }
    return [
        BigInt("0x" + account.slice(2, 34)),
        BigInt("0x" + account.slice(34, 66)),
    ]
}

export function compareAccounts(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

export function parseUnsigned(value: string, limit: bigint, what: string): bigint {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        throw new SettlementEncodingError(`${what} is not a decimal string`)
    }
    const n = BigInt(value)
    if (n >= limit) throw new SettlementEncodingError(`${what} is out of range`)
    return n
}

/**
 * Net change as the signed integer the validator verified and applies. The
 * magnitude is range-checked before it becomes a field element, so a debit
 * can never be read as a credit of p minus the debit.
 */
export function parseDelta(value: string): bigint {
    if (typeof value !== "string" || !SIGNED_DECIMAL.test(value)) {
        throw new SettlementEncodingError("delta is not a signed decimal string")
    }
    const n = BigInt(value)
    if ((n < 0n ? -n : n) >= AMOUNT_LIMIT) {
        throw new SettlementEncodingError("delta is out of range")
    }
    return n
}

export function fieldToHex(x: bigint): string {
    return "0x" + x.toString(16).padStart(64, "0")
}

export function hexToField(hex: string): bigint {
    if (!FIELD_HEX.test(hex)) {
        throw new SettlementEncodingError(`not a 32-byte hex field element: ${hex}`)
    }
    return BigInt(hex)
}

export interface CommitmentOpening {
    from: string
    to: string
    amount: bigint
    fee: bigint
    nonce: bigint
    salt: bigint
}

/** c = Poseidon(from_hi, from_lo, to_hi, to_lo, amount, fee, nonce, salt) */
export function settlementCommitment(o: CommitmentOpening): bigint {
    if (o.amount < 0n || o.amount >= AMOUNT_LIMIT) {
        throw new SettlementEncodingError("amount is out of range")
    }
    if (o.fee < 0n || o.fee >= AMOUNT_LIMIT) {
        throw new SettlementEncodingError("fee is out of range")
    }
    if (o.nonce < 0n || o.nonce >= NONCE_LIMIT) {
        throw new SettlementEncodingError("nonce is out of range")
    }
    if (o.salt < 0n || o.salt >= 1n << BigInt(8 * SALT_BYTES)) {
        throw new SettlementEncodingError("salt is out of range")
    }
    const [fromHi, fromLo] = accountLimbs(o.from)
    const [toHi, toLo] = accountLimbs(o.to)
    return poseidon8([fromHi, fromLo, toHi, toLo, o.amount, o.fee, o.nonce, o.salt])
}

/** What the sender signs with their account key. */
export function settlementSignatureMessage(
    chainId: number,
    l2psUid: string,
    commitment: bigint,
): Uint8Array {
    if (!Number.isSafeInteger(chainId) || chainId < 0) {
        throw new SettlementEncodingError(`invalid chain id ${chainId}`)
    }
    if (typeof l2psUid !== "string" || l2psUid.length === 0 || l2psUid.includes(":")) {
        throw new SettlementEncodingError("invalid L2PS uid")
    }
    return new TextEncoder().encode(
        `${SETTLEMENT_SIGNATURE_DOMAIN}${chainId}:${l2psUid}:${fieldToHex(commitment)}`,
    )
}

/** Inactive slots hash as 0. */
export function commitmentsHash(commitments: bigint[]): bigint {
    if (commitments.length > SETTLEMENT_TRANSFERS) {
        throw new SettlementEncodingError("too many commitments")
    }
    const slots = [...commitments]
    while (slots.length < SETTLEMENT_TRANSFERS) slots.push(0n)
    return slotsHash(slots)
}

export interface PublicTransfer {
    commitment: bigint
    signer: string
    nonce: bigint
    fee: bigint
}

export interface PublicAccount {
    account: string
    /** From the validator's own working state, never from the transaction. */
    balanceBefore: bigint
    delta: bigint
}

/**
 * The circuit's public signals, in its declared order:
 *   commitmentsHash,
 *   transferActive[N], signerHi[N], signerLo[N], nonce[N], fee[N],
 *   accountActive[M], accountHi[M], accountLo[M], balanceBefore[M],
 *   deltaNegative[M], deltaMagnitude[M]
 * Active slots first; inactive slots are all zero.
 */
export function settlementPublicSignals(
    transfers: PublicTransfer[],
    accounts: PublicAccount[],
): bigint[] {
    const N = SETTLEMENT_TRANSFERS
    const M = SETTLEMENT_ACCOUNTS
    if (transfers.length === 0 || transfers.length > N) {
        throw new SettlementEncodingError(`batch has ${transfers.length} transfers, 1..${N} allowed`)
    }
    if (accounts.length === 0 || accounts.length > M) {
        throw new SettlementEncodingError(`batch has ${accounts.length} accounts, 1..${M} allowed`)
    }
    for (let i = 1; i < accounts.length; i++) {
        if (compareAccounts(accounts[i - 1].account, accounts[i].account) >= 0) {
            throw new SettlementEncodingError("accounts are not strictly increasing")
        }
    }
    const pad = (xs: bigint[], n: number) => [...xs, ...Array(n - xs.length).fill(0n)]
    const signerLimbs = transfers.map(t => accountLimbs(t.signer))
    const accountLimbList = accounts.map(a => accountLimbs(a.account))
    for (const a of accounts) {
        if (a.balanceBefore < 0n || a.balanceBefore >= AMOUNT_LIMIT) {
            throw new SettlementEncodingError("balance is out of range")
        }
        if ((a.delta < 0n ? -a.delta : a.delta) >= AMOUNT_LIMIT) {
            throw new SettlementEncodingError("delta is out of range")
        }
    }
    for (const t of transfers) {
        if (t.nonce < 0n || t.nonce >= NONCE_LIMIT) {
            throw new SettlementEncodingError("nonce is out of range")
        }
        if (t.fee < 0n || t.fee >= AMOUNT_LIMIT) {
            throw new SettlementEncodingError("fee is out of range")
        }
    }
    return [
        commitmentsHash(transfers.map(t => t.commitment)),
        ...pad(transfers.map(() => 1n), N),
        ...pad(signerLimbs.map(l => l[0]), N),
        ...pad(signerLimbs.map(l => l[1]), N),
        ...pad(transfers.map(t => t.nonce), N),
        ...pad(transfers.map(t => t.fee), N),
        ...pad(accounts.map(() => 1n), M),
        ...pad(accountLimbList.map(l => l[0]), M),
        ...pad(accountLimbList.map(l => l[1]), M),
        ...pad(accounts.map(a => a.balanceBefore), M),
        ...pad(accounts.map(a => (a.delta < 0n ? 1n : 0n)), M),
        ...pad(accounts.map(a => (a.delta < 0n ? -a.delta : a.delta)), M),
    ]
}

/** Count of public signals: 1 + 5N + 6M. */
export const SETTLEMENT_PUBLIC_SIGNALS = 1 + 5 * SETTLEMENT_TRANSFERS + 6 * SETTLEMENT_ACCOUNTS

const HASH_CHUNK = 7
const SIGNER_INDEX_SHIFT = 192n
const TRANSFER_ACTIVE_SHIFT = 200n

/**
 * Interface v1.1: the circuit's only public input, a Poseidon sponge over the
 * public signals of settlementPublicSignals. Each verifier computes it from
 * its own signals, so it binds exactly the values Interface v1 exposed.
 *
 * The signals are packed into 2 + N + 4M field elements:
 *   commitmentsHash,
 *   per transfer: fee + nonce * 2^128 + senderIndex * 2^192 + transferActive * 2^200,
 *   per account: hi, lo, balanceBefore, deltaMagnitude,
 *   sum over accounts j of accountActive * 4^j + deltaNegative * 2 * 4^j,
 * where senderIndex is the slot of the active account whose limbs are the
 * signer's (0 for an idle transfer). They are absorbed 7 at a time,
 * h = Poseidon8(h, e[7k], ..., e[7k + 6]) from h = 0, the last chunk padded
 * with zeros; the result is the final h.
 *
 * Throws SettlementEncodingError for signals that are not a statement: a
 * value out of its range, or a signer that is not an active account of the
 * batch (or non-zero signer limbs on an idle transfer).
 */
export function settlementPublicHash(signals: readonly bigint[]): bigint {
    const N = SETTLEMENT_TRANSFERS
    const M = SETTLEMENT_ACCOUNTS
    if (signals.length !== SETTLEMENT_PUBLIC_SIGNALS) {
        throw new SettlementEncodingError(`expected ${SETTLEMENT_PUBLIC_SIGNALS} public signals, got ${signals.length}`)
    }
    let at = 0
    const take = (count: number, limit: bigint): bigint[] => {
        const part = signals.slice(at, at + count)
        part.forEach((v, k) => {
            if (typeof v !== "bigint" || v < 0n || v >= limit) {
                throw new SettlementEncodingError(`public signal ${at + k} is out of range`)
            }
        })
        at += count
        return part
    }
    const [batchHash] = take(1, FIELD_ORDER)
    const transferActive = take(N, 2n)
    const signerHi = take(N, AMOUNT_LIMIT)
    const signerLo = take(N, AMOUNT_LIMIT)
    const nonce = take(N, NONCE_LIMIT)
    const fee = take(N, AMOUNT_LIMIT)
    const accountActive = take(M, 2n)
    const accountHi = take(M, AMOUNT_LIMIT)
    const accountLo = take(M, AMOUNT_LIMIT)
    const balanceBefore = take(M, AMOUNT_LIMIT)
    const deltaNegative = take(M, 2n)
    const deltaMagnitude = take(M, AMOUNT_LIMIT)

    const elements: bigint[] = [batchHash]
    for (let i = 0; i < N; i++) {
        let senderIndex = 0
        if (transferActive[i] === 1n) {
            senderIndex = accountHi.findIndex(
                (hi, j) => accountActive[j] === 1n && hi === signerHi[i] && accountLo[j] === signerLo[i],
            )
            if (senderIndex < 0) {
                throw new SettlementEncodingError(`the signer of transfer ${i} is not an account of the batch`)
            }
        } else if (signerHi[i] !== 0n || signerLo[i] !== 0n) {
            throw new SettlementEncodingError(`idle transfer slot ${i} names a signer`)
        }
        elements.push(
            fee[i] +
                (nonce[i] << 128n) +
                (BigInt(senderIndex) << SIGNER_INDEX_SHIFT) +
                (transferActive[i] << TRANSFER_ACTIVE_SHIFT),
        )
    }
    let flags = 0n
    for (let j = 0; j < M; j++) {
        elements.push(accountHi[j], accountLo[j], balanceBefore[j], deltaMagnitude[j])
        flags += (accountActive[j] << BigInt(2 * j)) + (deltaNegative[j] << BigInt(2 * j + 1))
    }
    elements.push(flags)
    while (elements.length % HASH_CHUNK !== 0) elements.push(0n)
    let h = 0n
    for (let k = 0; k < elements.length; k += HASH_CHUNK) {
        h = poseidon8([h, ...elements.slice(k, k + HASH_CHUNK)])
    }
    return h
}
