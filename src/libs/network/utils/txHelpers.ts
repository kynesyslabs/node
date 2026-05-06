// Canonical transaction-helper utilities.
//
// Single source of truth for extracting the sender address from a tx.
// Three call sites used to maintain their own copies with subtly
// different rules (some lowercased, some did not), causing the
// governance vote / staking address-case mismatch documented in PR #778
// review (G-1 + G-4). Everything in this module assumes the project's
// canonicalisation rule: validator and account addresses are stored
// lower-case across the system. Producers (staking edits) and consumers
// (governance lookups) must agree, and they agree by funnelling through
// here.

import type { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * Extract the sender address from a transaction. Reads `tx.content.from`
 * with a fallback to `tx.content.from_ed25519_address`. Returns `null`
 * when neither field is a non-empty string.
 *
 * Always returns the lower-cased form. Address case is purely a display
 * concern (Ethereum-style checksum, ed25519 hex); the canonical
 * identifier in this codebase is lowercase. Callers comparing against
 * stored validator rows can rely on the rows also being lowercase
 * because every staking insert site goes through `canonicalAddress` /
 * this helper.
 */
export function requireSender(tx: Transaction): string | null {
    const from = tx.content?.from
    if (typeof from === "string" && from.length > 0) {
        return from.toLowerCase()
    }
    const ed = tx.content?.from_ed25519_address
    if (typeof ed === "string" && ed.length > 0) {
        return ed.toLowerCase()
    }
    return null
}

/**
 * Lower-case an address-like string. Use at every persistence boundary
 * — validator rows, vote rows, proposal proposer key, anywhere a wallet
 * address ends up in the database — so lookups via `requireSender` find
 * a match.
 */
export function canonicalAddress(addr: string | null | undefined): string {
    if (!addr) return ""
    return addr.toLowerCase()
}
