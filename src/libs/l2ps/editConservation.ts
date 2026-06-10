/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * Tx-level conservation invariants for L2PS passthrough gcr_edits (audit C4).
 *
 * Pure, dependency-light (no DB/SDK) so it can be unit-tested in isolation and
 * reused by L2PSTransactionExecutor without dragging in the datasource graph.
 *
 * Passthrough edits come from a participant-signed L2PS tx and are later
 * applied to L1 gcr_main at consensus with NO ZK soundness (the proof is a
 * sha256 self-check, not a PLONK verify). Per-edit validation only checks a
 * `remove` has balance, so without these invariants a signed tx could carry
 * {balance,add,self,HUGE} (mint) or {balance,remove,victim} (theft).
 */

import type { GCREdit } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

export interface ConservationResult {
    success: boolean
    message: string
}

/**
 * Normalize an account ref to hex. A GCREdit `account` may be a hex string or
 * a forge-key object/bytes — direct === between the forms always fails, which
 * is how a forged edit could dodge a sender-binding check. Mirrors
 * HandleGCR.normalizePubkey.
 */
export function normalizeAccount(account: unknown): string {
    if (typeof account === "string") return account
    return forgeToHex(account as never)
}

/**
 * Enforce, over the `balance` edits in a passthrough edit set:
 *   1. every `remove` (debit) account is one of `signerAccounts` — a
 *      participant may only debit its own account(s);
 *   2. Σ(remove amounts) === Σ(add amounts) — zero-sum, no net mint;
 *   3. no negative amounts.
 *
 * `add` may credit ANY account (legit transfers/splits) as long as it is
 * funded by an equal debit from the signer. Non-balance edits (nonce, etc.)
 * are ignored. No balance edits at all → success.
 *
 * @param edits           the tx's gcr_edits.
 * @param signerAccounts  normalized signer identities (from + from_ed25519).
 */
export function validateEditConservation(
    edits: GCREdit[],
    signerAccounts: Iterable<string>,
): ConservationResult {
    const signers = new Set<string>()
    for (const s of signerAccounts) signers.add(s)

    let totalRemove = 0n
    let totalAdd = 0n
    let sawBalanceEdit = false

    for (const edit of edits) {
        if (edit.type !== "balance") continue
        sawBalanceEdit = true
        const amount = BigInt(edit.amount as string | number | bigint)
        if (amount < 0n) {
            return {
                success: false,
                message: `L2PS edit has negative amount for ${String(edit.account)}`,
            }
        }
        if (edit.operation === "remove") {
            const acct = normalizeAccount(edit.account)
            if (!signers.has(acct)) {
                return {
                    success: false,
                    message: `L2PS tx may only debit the signer's account; got remove on ${acct}`,
                }
            }
            totalRemove += amount
        } else if (edit.operation === "add") {
            totalAdd += amount
        }
    }

    if (sawBalanceEdit && totalRemove !== totalAdd) {
        return {
            success: false,
            message: `L2PS balance edits are not zero-sum: removed ${totalRemove}, added ${totalAdd}`,
        }
    }

    return { success: true, message: "Edit conservation validated" }
}
