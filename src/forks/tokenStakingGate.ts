import type { Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "./forkGates"

/** The transaction types that bond or release a token stake. */
export const TOKEN_STAKING_TYPES: ReadonlySet<string> = new Set([
    "validatorStake",
    "validatorUnstake",
])

export const TOKEN_STAKING_REFUSAL =
    "token staking is not enabled on this network (fork tokenStaking)"

type TxView = Pick<Transaction, "content"> | { content?: unknown }

function contentOf(tx: TxView): Record<string, unknown> {
    const content = (tx as { content?: unknown }).content
    return content && typeof content === "object"
        ? (content as Record<string, unknown>)
        : {}
}

/**
 * Whether a `validatorStake` edit bonds or releases a stake. An exit shipped
 * as a rollback counts too: before `stakeApplyChecks`, apply turns it into a
 * stake.
 */
export function isTokenStakingEdit(edit: unknown): boolean {
    if (!edit || typeof edit !== "object") return false
    const { type, operation, isRollback } = edit as Record<string, unknown>
    if (String(type) !== "validatorStake") return false
    return (
        operation === "stake" ||
        operation === "unstake" ||
        (operation === "exit" && Boolean(isRollback))
    )
}

/** Whether a transaction is a stake or unstake, or carries an edit that is one. */
export function carriesTokenStaking(tx: TxView): boolean {
    const content = contentOf(tx)
    if (TOKEN_STAKING_TYPES.has(String(content.type))) return true
    const edits = content.gcr_edits
    return Array.isArray(edits) && edits.some(isTokenStakingEdit)
}

/** Whether token staking is open for the block applied on `tip`. */
export function tokenStakingOpen(tip: number): boolean {
    return (
        !isForkActive("tokenStakingGate", tip) || isForkActive("tokenStaking", tip)
    )
}

/**
 * Why `tx` is refused under the `tokenStakingGate` rule, or null when it
 * passes. `open` is `tokenStakingOpen` for the block the transaction would
 * land in, read from the same tip as the other admission and apply gates.
 */
export function tokenStakingRefusal(tx: TxView, open: boolean): string | null {
    return !open && carriesTokenStaking(tx) ? TOKEN_STAKING_REFUSAL : null
}
