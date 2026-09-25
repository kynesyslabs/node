/**
 * Who pays, and which nonce is spent, for each way a Work can end.
 *
 * Both answers have a failure mode in each direction. Charge nothing for a
 * Work that executed and rolled back, and a failing Work can be retried for
 * free until it happens to succeed. Charge twice for one Work — once when it
 * committed and again when its receipt is fetched — and the submitter pays for
 * an effect that happened once. Burn a nonce for an attempt the chain never
 * included, and the account stalls behind a transaction nobody can find.
 *
 * So each terminal outcome states both answers explicitly rather than
 * inheriting them from whatever the transaction path happened to do.
 */

export type WorkOutcome =
    /** Refused before execution: nothing was read, nothing was staged. */
    | "refused-at-admission"
    /** Executed and committed. */
    | "committed"
    /** Executed, effects discarded. */
    | "rolled-back"
    /** Superseded an attempt the chain authoritatively did not include. */
    | "replaced"
    /** Never included, and the submitter gave up. */
    | "dropped"
    /** Its validity window closed before inclusion. */
    | "expired"
    /** Re-submitted only to recover the receipt of a Work that already ran. */
    | "replayed"

export interface Settlement {
    /** Charge the fee for this attempt. */
    chargeFee: boolean
    /** Consume the sender's nonce. */
    consumeNonce: boolean
    /** Why, in one line, for the receipt and for whoever reads it later. */
    rationale: string
}

const SETTLEMENTS: Record<WorkOutcome, Settlement> = {
    "refused-at-admission": {
        chargeFee: false,
        consumeNonce: false,
        rationale: "nothing executed, so there is nothing to charge for",
    },
    committed: {
        chargeFee: true,
        consumeNonce: true,
        rationale: "the Work executed and its effects stand",
    },
    "rolled-back": {
        chargeFee: true,
        consumeNonce: true,
        rationale:
            "execution consumed the same resources as a success; free failure is an unlimited retry",
    },
    replaced: {
        chargeFee: false,
        consumeNonce: false,
        rationale:
            "the replaced attempt was never included, and burning its nonce would stall the account",
    },
    dropped: {
        chargeFee: false,
        consumeNonce: false,
        rationale: "never included, so it never used anything",
    },
    expired: {
        chargeFee: false,
        consumeNonce: false,
        rationale: "its window closed before inclusion; nothing executed",
    },
    replayed: {
        chargeFee: false,
        // The chain's replay protection is per transaction: an included
        // transaction that left its nonce unspent could be included again.
        consumeNonce: true,
        rationale:
            "recovers the receipt of a Work that already paid; charging again bills one effect twice",
    },
}

export function settlementFor(outcome: WorkOutcome): Settlement {
    const settlement = SETTLEMENTS[outcome]
    if (!settlement) {
        throw new SettlementError(
            `no fee and nonce rule is defined for outcome '${outcome}'`,
            "unknown-outcome",
        )
    }
    return settlement
}

export class SettlementError extends Error {
    constructor(
        message: string,
        readonly reason: "unknown-outcome" | "double-charge" | "double-nonce",
    ) {
        super(message)
        this.name = "SettlementError"
    }
}

/**
 * One Work, one charge.
 *
 * A Work may be attempted several times — a replacement after
 * authoritative non-inclusion, a replay to recover a receipt — but only the
 * attempt that actually executed may charge. More than one charge across the
 * attempts of a single Work is the double authorization the profile forbids,
 * and it is worth catching here rather than in an account balance later.
 */
export function assertSingleCharge(outcomes: WorkOutcome[]): void {
    const charged = outcomes.filter(o => settlementFor(o).chargeFee)
    if (charged.length > 1) {
        throw new SettlementError(
            `a Work charged ${charged.length} times across its attempts (${charged.join(", ")})`,
            "double-charge",
        )
    }
    // A replay spends its own transaction's nonce, not the Work's: only the
    // attempts that executed the Work count against it.
    const consumed = outcomes.filter(o => o !== "replayed" && settlementFor(o).consumeNonce)
    if (consumed.length > 1) {
        throw new SettlementError(
            `a Work consumed the nonce ${consumed.length} times across its attempts`,
            "double-nonce",
        )
    }
}

export interface SettlementParts<E> {
    /** The Work's own edits: its Work-kind edits and its transfers. */
    work: E[]
    /** What the sender pays to have the transaction processed. */
    fee: E[]
    /** The sender's nonce spend. */
    nonce: E[]
}

/**
 * Split a Work transaction's edits into the Work, its fee and its nonce.
 *
 * The edits are generated from the signed payload in a fixed order — the
 * Work's edits with its transfers, then the transaction envelope — and bound
 * to that payload before this runs, so the envelope is whatever follows the
 * Work's own edits.
 */
export function splitSettlement<E extends { type: string }>(
    edits: readonly E[],
    workKinds: ReadonlySet<string>,
    transferCount: number,
): SettlementParts<E> {
    const own = edits.filter(e => workKinds.has(e.type)).length + 2 * transferCount
    const envelope = edits.slice(own)
    return {
        work: edits.slice(0, own),
        fee: envelope.filter(e => e.type !== "nonce"),
        nonce: envelope.filter(e => e.type === "nonce"),
    }
}

/** The edits to apply for a Work that ended with `outcome`, in order. */
export function settledEdits<E>(parts: SettlementParts<E>, outcome: WorkOutcome, includeWork: boolean): E[] {
    const rule = settlementFor(outcome)
    return [
        ...(includeWork ? parts.work : []),
        ...(rule.chargeFee ? parts.fee : []),
        ...(rule.consumeNonce ? parts.nonce : []),
    ]
}
