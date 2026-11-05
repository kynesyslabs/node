import type { Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "./forkGates"

/** The transaction types, and the edit types, of network-upgrade governance. */
export const GOVERNANCE_TYPES: ReadonlySet<string> = new Set([
    "networkUpgrade",
    "networkUpgradeVote",
])

type TxView = Pick<Transaction, "content"> | { content?: unknown }

function contentOf(tx: TxView): Record<string, unknown> {
    const content = (tx as { content?: unknown }).content
    return content && typeof content === "object"
        ? (content as Record<string, unknown>)
        : {}
}

function governanceEdits(tx: TxView): Array<Record<string, unknown>> {
    const edits = contentOf(tx).gcr_edits
    if (!Array.isArray(edits)) return []
    return edits.filter(
        e => e && typeof e === "object" && GOVERNANCE_TYPES.has(String(e.type)),
    )
}

/** Whether a transaction is a governance transaction or carries a governance edit. */
export function carriesGovernance(tx: TxView): boolean {
    return (
        GOVERNANCE_TYPES.has(String(contentOf(tx).type)) ||
        governanceEdits(tx).length > 0
    )
}

/**
 * The signing account as an edit names it: the ed25519 address the SDK copies
 * into every edit it generates, `0x`-prefixed and lower-cased, the form the
 * governance routines persist voters and proposers under.
 */
function signerAccount(tx: TxView): string {
    const content = contentOf(tx)
    const ed = content.from_ed25519_address
    const sender =
        typeof ed === "string" && ed.length > 0
            ? ed
            : typeof content.from === "string"
              ? content.from
              : ""
    if (sender === "") return ""
    const lower = sender.toLowerCase()
    return lower.startsWith("0x") ? lower : `0x${lower}`
}

/**
 * Why `tx` is refused under the `networkGovernance` rule, or null when it
 * passes. `active` is the fork state for the block the transaction would land
 * in, read from the same tip as the other admission and apply gates.
 *
 * Inactive, a governance transaction and any transaction carrying a
 * governance edit are refused. Active, each governance edit must ride in a
 * transaction of its own type and name the signer's account, so nobody can
 * vote or propose with another validator's stake.
 */
export function governanceGateRefusal(
    tx: TxView,
    active: boolean,
): string | null {
    if (!carriesGovernance(tx)) return null
    if (!active) return "network governance is not active at this height"

    const type = String(contentOf(tx).type)
    const signer = signerAccount(tx)
    for (const edit of governanceEdits(tx)) {
        const editType = String(edit.type)
        if (editType !== type) {
            return `${editType} edit carried by a ${type} transaction`
        }
        const account =
            typeof edit.account === "string" ? edit.account.toLowerCase() : ""
        if (signer === "" || account !== signer) {
            return `${editType} edit acts on another account than the signer`
        }
    }
    return null
}

/** Whether `networkGovernance` holds for the block applied on `tip`. */
export function networkGovernanceActive(tip: number): boolean {
    return isForkActive("networkGovernance", tip)
}
