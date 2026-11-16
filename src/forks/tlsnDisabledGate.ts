import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/** The native operations that request or store a TLSNotary attestation. */
export const TLSN_OPERATIONS: ReadonlySet<string> = new Set([
    "tlsn_request",
    "tlsn_store",
])

export const TLSN_DISABLED_REFUSAL =
    "TLSNotary is not enabled on this network (fork tlsnDisabled)"

type TxView = Pick<Transaction, "content"> | { content?: unknown }

function contentOf(tx: TxView): Record<string, unknown> {
    const content = (tx as { content?: unknown }).content
    return content && typeof content === "object"
        ? (content as Record<string, unknown>)
        : {}
}

/** Whether TLSNotary is off for the block applied on `tip`. */
export function tlsnDisabledAt(tip: number): boolean {
    return isForkActive("tlsnDisabled", tip)
}

/** Whether TLSNotary is off at this node's tip. */
export function tlsnDisabled(): boolean {
    return tlsnDisabledAt(getSharedState.lastBlockNumber ?? 0)
}

/**
 * Whether `tx` is a native `tlsn_request` or `tlsn_store`, or carries a
 * `tlsnotary` edit, the one that writes a stored proof.
 */
export function carriesTlsn(tx: TxView): boolean {
    const content = contentOf(tx)
    if (content.type === "native" && Array.isArray(content.data)) {
        const payload = content.data[1] as { nativeOperation?: unknown } | undefined
        const operation = payload?.nativeOperation
        if (typeof operation === "string" && TLSN_OPERATIONS.has(operation)) return true
    }
    const edits = content.gcr_edits
    return (
        Array.isArray(edits) &&
        edits.some(e => !!e && typeof e === "object" && (e as { type?: unknown }).type === "tlsnotary")
    )
}

/**
 * Why `tx` is refused under `tlsnDisabled`, or null when it passes.
 * `disabled` is `tlsnDisabledAt` for the block the transaction would land
 * in. Refused before apply, so the request pays no fee, burns nothing and
 * gets no attestation token.
 */
export function tlsnDisabledRefusal(tx: TxView, disabled: boolean): string | null {
    return disabled && carriesTlsn(tx) ? TLSN_DISABLED_REFUSAL : null
}
