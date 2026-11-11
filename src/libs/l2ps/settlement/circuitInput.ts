/**
 * Witness input of L2PSSettlement(10, 20) from a settlement plan. The public
 * part comes from settlementPublicSignals, the same function validators use,
 * so prover and verifier cannot disagree on order or padding.
 */
import {
    SETTLEMENT_ACCOUNTS,
    SETTLEMENT_PUBLIC_SIGNALS,
    SETTLEMENT_TRANSFERS,
    SettlementEncodingError,
    accountLimbs,
    compareAccounts,
    settlementCommitment,
    settlementPublicSignals,
} from "./encoding"
import type { SettlementPlan } from "./types"

/** Circuit input names, in public signal order, with their slot counts. */
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
    ["balanceBefore", SETTLEMENT_ACCOUNTS],
    ["deltaNegative", SETTLEMENT_ACCOUNTS],
    ["deltaMagnitude", SETTLEMENT_ACCOUNTS],
]

export type SettlementCircuitInput = Record<string, string | string[]>

export interface BuiltSettlementInput {
    input: SettlementCircuitInput
    /** The 171 public signals the proof must verify against. */
    publicSignals: bigint[]
}

const pad = (xs: bigint[], n: number): bigint[] => [...xs, ...Array<bigint>(n - xs.length).fill(0n)]
const dec = (xs: bigint[]): string[] => xs.map(x => x.toString())

/**
 * Throws SettlementEncodingError when the plan is not one the circuit can
 * prove: the plan is replayed here (debit, then credit, in batch order) so a
 * plan that would only fail inside witness generation fails with a reason.
 */
export function buildSettlementCircuitInput(plan: SettlementPlan): BuiltSettlementInput {
    const { transfers, changes, balancesBefore } = plan
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

    const running = new Map<string, bigint>()
    for (const a of accounts) {
        const b = balancesBefore.get(a)
        if (b === undefined) throw new SettlementEncodingError(`no balance before for ${a}`)
        running.set(a, b)
    }
    const touched = new Set<string>()
    for (const t of transfers) {
        if (!index.has(t.from) || !index.has(t.to)) {
            throw new SettlementEncodingError("a transfer touches an account missing from the changes")
        }
        if (settlementCommitment(t) !== t.commitment) {
            throw new SettlementEncodingError("a commitment does not open to its transfer")
        }
        const debited = (running.get(t.from) as bigint) - t.amount - t.fee
        if (debited < 0n) throw new SettlementEncodingError("a transfer overdraws its sender")
        running.set(t.from, debited)
        running.set(t.to, (running.get(t.to) as bigint) + t.amount)
        touched.add(t.from).add(t.to)
    }
    for (const c of changes) {
        if (!touched.has(c.account)) {
            throw new SettlementEncodingError(`account ${c.account} is not touched by any transfer`)
        }
        const before = balancesBefore.get(c.account) as bigint
        if ((running.get(c.account) as bigint) - before !== c.delta) {
            throw new SettlementEncodingError(`delta of ${c.account} is not the result of the transfers`)
        }
    }

    const publicSignals = settlementPublicSignals(
        transfers.map(t => ({ commitment: t.commitment, signer: t.from, nonce: t.nonce, fee: t.fee })),
        changes.map(c => ({
            account: c.account,
            balanceBefore: balancesBefore.get(c.account) as bigint,
            delta: c.delta,
        })),
    )
    if (publicSignals.length !== SETTLEMENT_PUBLIC_SIGNALS) {
        throw new SettlementEncodingError("public signal count does not match the circuit")
    }

    const input: SettlementCircuitInput = {}
    let at = 0
    for (const [name, count] of PUBLIC_INPUT_LAYOUT) {
        const slice = publicSignals.slice(at, at + count)
        input[name] = count === 1 ? slice[0].toString() : dec(slice)
        at += count
    }

    const N = SETTLEMENT_TRANSFERS
    const toLimbs = transfers.map(t => accountLimbs(t.to))
    input.toHi = dec(pad(toLimbs.map(l => l[0]), N))
    input.toLo = dec(pad(toLimbs.map(l => l[1]), N))
    input.amount = dec(pad(transfers.map(t => t.amount), N))
    input.salt = dec(pad(transfers.map(t => t.salt), N))
    input.senderIndex = dec(pad(transfers.map(t => BigInt(index.get(t.from) as number)), N))
    input.receiverIndex = dec(pad(transfers.map(t => BigInt(index.get(t.to) as number)), N))
    return { input, publicSignals }
}
