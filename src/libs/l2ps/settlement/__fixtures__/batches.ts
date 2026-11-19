/**
 * Deterministic settlement batches shared by the planner, circuit and verifier
 * tests and by the proof fixture generator. Signatures are not part of the
 * proof, so they are left empty here.
 */
import { SETTLEMENT_TRANSFERS, settlementCommitment } from "../encoding"
import type { DecryptedTransfer } from "../types"

/** An account made of one repeated byte. */
export const acct = (byte: number): string => "0x" + byte.toString(16).padStart(2, "0").repeat(32)

/** Two accounts with the same hi limb, so their order is decided by the lo limb. */
export const SAME_HI_LOW = "0x" + "aa".repeat(16) + "01".repeat(16)
export const SAME_HI_HIGH = "0x" + "aa".repeat(16) + "02".repeat(16)

let saltCounter = 1000n

export function transfer(
    from: string,
    to: string,
    amount: bigint,
    fee: bigint,
    nonce: bigint,
    salt: bigint = saltCounter++,
): DecryptedTransfer {
    const t = { txHash: `tx-${salt}`, from, to, amount, fee, nonce, salt, commitment: 0n, signature: "0x" }
    t.commitment = settlementCommitment(t)
    return t
}

export interface Batch {
    name: string
    transfers: DecryptedTransfer[]
    balances: Map<string, bigint>
    nonces: Map<string, bigint>
}

const DEM = 10n ** 9n

export function oneTransfer(): Batch {
    const a = acct(0x11)
    const b = acct(0x22)
    return {
        name: "one transfer",
        transfers: [transfer(a, b, 1000n, 10n, 1n, 1n)],
        balances: new Map([[a, 1_000_000n]]),
        nonces: new Map(),
    }
}

/**
 * Nine transfers (a full batch) over six accounts: repeated signers with
 * consecutive nonces, a receiver spending what it received earlier in the
 * batch, a self-transfer, a zero amount, and two accounts ordered by their
 * lo limb.
 */
export function mixedTransfers(): Batch {
    const a = acct(0x11)
    const b = acct(0x22)
    const c = acct(0x33)
    const d = acct(0x44)
    return {
        name: "mixed transfers",
        transfers: [
            transfer(a, b, 300n * DEM, 1_000n, 6n, 11n),
            transfer(a, b, 200n * DEM, 1_000n, 7n, 12n),
            // b starts empty: it can only pay out of the two credits above.
            transfer(b, c, 499n * DEM, 1_000n, 1n, 13n),
            transfer(c, c, 100n * DEM, 1_000n, 3n, 14n),
            transfer(c, d, 0n, 1_000n, 4n, 15n),
            transfer(d, SAME_HI_HIGH, 5n * DEM, 2_000n, 1n, 16n),
            transfer(SAME_HI_HIGH, SAME_HI_LOW, 1n * DEM, 1_000n, 1n, 17n),
            transfer(SAME_HI_LOW, a, 1n, 1_000n, 1n, 18n),
            transfer(a, d, 7n, 1_000n, 8n, 19n),
        ],
        balances: new Map([
            [a, 1_000n * DEM],
            [c, 1n * DEM],
            [d, 10n * DEM],
            [SAME_HI_LOW, 1n * DEM],
        ]),
        nonces: new Map([
            [a, 5n],
            [c, 2n],
        ]),
    }
}

/** N transfers between 2N distinct accounts: every slot in use. */
export function allAccounts(): Batch {
    const transfers: DecryptedTransfer[] = []
    const balances = new Map<string, bigint>()
    for (let i = 0; i < SETTLEMENT_TRANSFERS; i++) {
        // Senders and receivers interleave so the sorted order differs from batch order.
        const from = acct(0xf0 - 2 * i)
        const to = acct(0x10 + 2 * i)
        balances.set(from, 1_000_000n + BigInt(i))
        transfers.push(transfer(from, to, 1_000n + BigInt(i), 10n, 1n, 100n + BigInt(i)))
    }
    return { name: "all accounts", transfers, balances, nonces: new Map() }
}

/** The sender must afford amount + fee before its own credit comes back. */
export function selfTransfer(): Batch {
    const a = acct(0x55)
    return {
        name: "self-transfer",
        transfers: [transfer(a, a, 500n, 10n, 1n, 2n)],
        balances: new Map([[a, 510n]]),
        nonces: new Map(),
    }
}

/** A zero amount still pays its fee; the receiver is named with delta 0. */
export function zeroAmountWithFee(): Batch {
    const a = acct(0x66)
    const b = acct(0x77)
    return {
        name: "zero amount with fee",
        transfers: [transfer(a, b, 0n, 10n, 1n, 3n)],
        balances: new Map([[a, 10n]]),
        nonces: new Map(),
    }
}

/** Small but mixed: the committed proof fixture is made from this one. */
export function fixtureBatch(): Batch {
    const a = acct(0x11)
    const b = acct(0x22)
    const c = acct(0x33)
    return {
        name: "fixture",
        transfers: [
            transfer(a, b, 700n, 10n, 1n, 21n),
            transfer(b, c, 650n, 10n, 1n, 22n),
            transfer(c, c, 40n, 10n, 1n, 23n),
        ],
        balances: new Map([
            [a, 1_000n],
            [b, 0n],
            [c, 5n],
        ]),
        nonces: new Map(),
    }
}

export const PROVEN_BATCHES = [oneTransfer, mixedTransfers, allAccounts, selfTransfer, zeroAmountWithFee]
