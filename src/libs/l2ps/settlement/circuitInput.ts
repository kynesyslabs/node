/**
 * Witness input of L2PSSettlement(N, M) from a settlement plan. The statement
 * comes from settlementPublicSignals and its hash from settlementPublicHash,
 * the same functions validators use, so prover and verifier cannot disagree
 * on order, padding or packing.
 */
import {
    SETTLEMENT_ACCOUNTS,
    SETTLEMENT_PUBLIC_SIGNALS,
    SETTLEMENT_TRANSFERS,
    SettlementEncodingError,
    accountLimbs,
    compareAccounts,
    settlementCommitment,
    settlementPublicHash,
    settlementPublicSignals,
} from "./encoding"
import type { SettlementPlan } from "./types"

/**
 * Interface v1 signal names, in public signal order, with their slot counts.
 * The circuit takes all of them except the signer limbs, which it reads from
 * the sender's account slot.
 */
export const PUBLIC_INPUT_LAYOUT: ReadonlyArray<readonly [string, number]> = [
    ["commitmentsHash", 1],
    ["transferActive", SETTLEMENT_TRANSFERS],
    ["signerHi", SETTLEMENT_TRANSFERS],
    ["signerLo", SETTLEMENT_TRANSFERS],
    ["nonce", SETTLEMENT_TRANSFERS],
    ["fee", SETTLEMENT_TRANSFERS],
    ["accountActive", SETTLEMENT_ACCOUNTS],
    ["accountHi", SETTLEMENT_ACCOUNTS],
    ["accountLo", SETTLEMENT_ACCOUNTS],
    ["deltaNegative", SETTLEMENT_ACCOUNTS],
    ["deltaMagnitude", SETTLEMENT_ACCOUNTS],
]

export type SettlementCircuitInput = Record<string, string | string[]>

export interface BuiltSettlementInput {
    input: SettlementCircuitInput
    /** The Interface v1 signals (1 + 5N + 5M) the proof must verify against. */
    publicSignals: bigint[]
    /** settlementPublicHash of publicSignals: the circuit's one public input. */
    publicHash: bigint
}

const SIGNER_LIMBS = new Set(["signerHi", "signerLo"])

const pad = (xs: bigint[], n: number): bigint[] => [...xs, ...Array<bigint>(n - xs.length).fill(0n)]
const dec = (xs: bigint[]): string[] => xs.map(x => x.toString())

/**
 * Throws SettlementEncodingError when the plan is not one the circuit can
 * prove: each change is recomputed from the transfers so a plan that would
 * only fail inside witness generation fails with a reason.
 */
export function buildSettlementCircuitInput(plan: SettlementPlan): BuiltSettlementInput {
    const { transfers, changes } = plan
    if (transfers.length === 0 || transfers.length > SETTLEMENT_TRANSFERS) {
        throw new SettlementEncodingError(`plan has ${transfers.length} transfers, 1..${SETTLEMENT_TRANSFERS} allowed`)
    }
    const accounts = changes.map(c => c.account)
    for (let i = 1; i < accounts.length; i++) {
        if (compareAccounts(accounts[i - 1], accounts[i]) >= 0) {
            throw new SettlementEncodingError("plan changes are not sorted and unique")
        }
    }
    const index = new Map(accounts.map((a, i) => [a, i]))

    const net = new Map<string, bigint>(accounts.map(a => [a, 0n]))
    const touched = new Set<string>()
    for (const t of transfers) {
        if (!index.has(t.from) || !index.has(t.to)) {
            throw new SettlementEncodingError("a transfer touches an account missing from the changes")
        }
        if (settlementCommitment(t) !== t.commitment) {
            throw new SettlementEncodingError("a commitment does not open to its transfer")
        }
        net.set(t.from, (net.get(t.from) as bigint) - t.amount - t.fee)
        net.set(t.to, (net.get(t.to) as bigint) + t.amount)
        touched.add(t.from).add(t.to)
    }
    for (const c of changes) {
        if (!touched.has(c.account)) {
            throw new SettlementEncodingError(`account ${c.account} is not touched by any transfer`)
        }
        if (net.get(c.account) !== c.delta) {
            throw new SettlementEncodingError(`delta of ${c.account} is not the result of the transfers`)
        }
    }

    const publicSignals = settlementPublicSignals(
        transfers.map(t => ({ commitment: t.commitment, signer: t.from, nonce: t.nonce, fee: t.fee })),
        changes.map(c => ({ account: c.account, delta: c.delta })),
    )
    if (publicSignals.length !== SETTLEMENT_PUBLIC_SIGNALS) {
        throw new SettlementEncodingError("public signal count does not match the circuit")
    }

    const input: SettlementCircuitInput = {}
    let at = 0
    for (const [name, count] of PUBLIC_INPUT_LAYOUT) {
        const slice = publicSignals.slice(at, at + count)
        if (!SIGNER_LIMBS.has(name)) input[name] = count === 1 ? slice[0].toString() : dec(slice)
        at += count
    }
    const publicHash = settlementPublicHash(publicSignals)
    input.publicHash = publicHash.toString()

    const N = SETTLEMENT_TRANSFERS
    const toLimbs = transfers.map(t => accountLimbs(t.to))
    input.toHi = dec(pad(toLimbs.map(l => l[0]), N))
    input.toLo = dec(pad(toLimbs.map(l => l[1]), N))
    input.amount = dec(pad(transfers.map(t => t.amount), N))
    input.salt = dec(pad(transfers.map(t => t.salt), N))
    input.senderIndex = dec(pad(transfers.map(t => BigInt(index.get(t.from) as number)), N))
    input.receiverIndex = dec(pad(transfers.map(t => BigInt(index.get(t.to) as number)), N))
    return { input, publicSignals, publicHash }
}
