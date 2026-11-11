/**
 * L2PS settlement v1 encoding, shared by the circuit input builder, the
 * aggregator and block validation. The SDK mirrors commitment and message
 * byte for byte; `__fixtures__/settlementVectors.json` pins both sides.
 * Spec: docs/design/l2ps-zk-settlement.md, "Interface v1".
 */
import { poseidon8 } from "poseidon-lite/poseidon8"
import { poseidon10 } from "poseidon-lite/poseidon10"

/** Transfer slots per batch proof. */
export const SETTLEMENT_TRANSFERS = 10
/** Account slots per batch proof: a sender and a receiver per transfer. */
export const SETTLEMENT_ACCOUNTS = 2 * SETTLEMENT_TRANSFERS
export const SETTLEMENT_VERSION = 1
export const SETTLEMENT_SIGNATURE_DOMAIN = "l2ps-settlement:v1:"

/** Amounts, fees, balances and net change magnitudes stay below this. */
export const AMOUNT_LIMIT = 1n << 128n
export const NONCE_LIMIT = 1n << 64n
export const SALT_BYTES = 31

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
    return poseidon10(slots)
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
