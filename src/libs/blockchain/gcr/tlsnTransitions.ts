/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { GCREdit, Transaction } from "@kynesyslabs/demosdk/types"

import { isForkActive } from "@/forks/forkGates"
import { TLSN_REQUEST_TTL_BLOCKS, TLSN_TOKEN_ID } from "@/libs/tlsnotary/onchainRequests"
import { verifyStoredPresentation } from "@/libs/tlsnotary/storedPresentation"
import { getSharedState } from "@/utilities/sharedState"
import { applyTime } from "./applyTime"
import { normalizePubkey } from "./normalizePubkey"

/**
 * The state a native `tlsn_request` or `tlsn_store` changes under
 * `tlsnVerified`, as `tlsnotary` edits the node derives from the signed body
 * and the block, never edits the client ships. The SDK builds only the burn,
 * so the signed edits and their binding are unchanged; like a fee credit,
 * the derived edit exists only in the copy the block applies.
 *
 * A request writes its token row; a store whose presentation verifies fills
 * in the proof of the sender's own pending, unexpired token. Rollback
 * derives the same edits from the body, so a reverted block undoes them.
 */

/** Writes the token of a `tlsn_request`. */
export interface GCREditTlsnRequest {
    type: "tlsnotary"
    operation: "request"
    account: string
    txhash: string
    isRollback: boolean
    data: {
        tokenId: string
        domain: string
        requestHeight: number
        expiresAtHeight: number
    }
}

/** Stores a verified presentation on the token a `tlsn_store` names. */
export interface GCREditTlsnVerifiedStore {
    type: "tlsnotary"
    operation: "verifiedStore"
    account: string
    txhash: string
    isRollback: boolean
    data: {
        tokenId: string
        proof: string
        storageType: "onchain"
        attestationId: string
        serverName: string
        attestedTimeSec: number
        storedAtHeight: number
    }
}

export type GCREditTlsnDerived = GCREditTlsnRequest | GCREditTlsnVerifiedStore

// Identity, not a field: a field could be shipped by a client to pass as
// node-derived, an object the node built itself cannot.
const derived = new WeakSet<object>()

/** Longest URL a request may name; the token keeps only its host. */
const MAX_REQUEST_URL_CHARS = 2048

/** Whether `tlsnVerified` governs TLSNotary transactions applied on this node's tip. */
export function tlsnVerifiedAtTip(): boolean {
    return isForkActive("tlsnVerified", getSharedState.lastBlockNumber ?? 0)
}

/** Whether `edit` is one the node derived, not one a transaction shipped. */
export function isNodeDerivedTlsnEdit(edit: unknown): boolean {
    return typeof edit === "object" && edit !== null && derived.has(edit)
}

/**
 * Why `tx` is refused for shipping its own `tlsnotary` edit under
 * `tlsnVerified`, or null. Only the node writes the table under the fork.
 */
export function shippedTlsnEditRefusal(tx: Pick<Transaction, "content">): string | null {
    const edits = tx.content?.gcr_edits
    if (!Array.isArray(edits)) return null
    const shipped = edits.some(
        e => (e as { type?: unknown })?.type === "tlsnotary" && !isNodeDerivedTlsnEdit(e),
    )
    return shipped ? "a tlsnotary edit is derived by the node, never shipped (tlsnVerified)" : null
}

/** The host a request URL locks its token to, or null when it names none over https. */
export function tlsnRequestDomain(url: unknown): string | null {
    if (typeof url !== "string" || url.length === 0 || url.length > MAX_REQUEST_URL_CHARS) return null
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return null
    }
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return null
    return parsed.hostname.toLowerCase()
}

type NativeView = { nativeOperation?: unknown; args?: unknown }

function nativeOf(tx: Transaction): { operation: string; args: unknown[] } | null {
    if ((tx.content?.type as string) !== "native" || !Array.isArray(tx.content.data)) return null
    const payload = tx.content.data[1] as NativeView | undefined
    const operation = payload?.nativeOperation
    if (operation !== "tlsn_request" && operation !== "tlsn_store") return null
    return { operation, args: Array.isArray(payload?.args) ? payload.args : [] }
}

function senderOf(tx: Transaction): string {
    return normalizePubkey(
        (tx.content.from_ed25519_address || tx.content.from) as string,
    )
}

function mark<T extends GCREditTlsnDerived>(edit: T): T {
    derived.add(edit)
    return edit
}

export interface TlsnTransitionContext {
    /** Height of the block the transactions apply in. */
    height: number
    isRollback: boolean
    /** Called once per transaction that cannot apply under the fork; it joins the block's refused set. */
    refuse: (tx: Transaction, reason: string) => void
}

/**
 * The derived edit of each TLSNotary transaction of `txs`, by tx hash. The
 * checks that need no chain state run here, once per block, and a
 * transaction that fails one is refused: it is included as failed with no
 * edits, as a refused settlement is. Those that need the token row run when
 * the edit applies. Empty unless `tlsnVerified` is active at the tip.
 *
 * Throws when a presentation cannot be judged on this node (the verifier is
 * missing or cannot run): the block must not apply here rather than fail
 * the transaction on this node alone.
 */
export function prepareTlsnTransitions(
    txs: Transaction[],
    ctx: TlsnTransitionContext,
): Map<string, GCREditTlsnDerived> {
    const prepared = new Map<string, GCREditTlsnDerived>()
    if (!tlsnVerifiedAtTip()) return prepared
    const tip = getSharedState.lastBlockNumber ?? 0
    const blockTimeSec = Math.floor(applyTime().getTime() / 1000)

    for (const tx of txs) {
        const native = nativeOf(tx)
        if (!native) continue
        const account = senderOf(tx)

        if (native.operation === "tlsn_request") {
            const domain = tlsnRequestDomain(native.args[0])
            if (domain === null) {
                if (!ctx.isRollback) ctx.refuse(tx, "tlsn_request needs an https URL with a host")
                continue
            }
            prepared.set(
                tx.hash,
                mark({
                    type: "tlsnotary",
                    operation: "request",
                    account,
                    txhash: tx.hash,
                    isRollback: false,
                    data: {
                        tokenId: tx.hash,
                        domain,
                        requestHeight: ctx.height,
                        expiresAtHeight: ctx.height + TLSN_REQUEST_TTL_BLOCKS,
                    },
                }),
            )
            continue
        }

        const [tokenId, proof, storageType] = native.args
        if (typeof tokenId !== "string" || !TLSN_TOKEN_ID.test(tokenId)) {
            if (!ctx.isRollback) ctx.refuse(tx, "tlsn_store must name a tlsn_request tx hash")
            continue
        }
        if (ctx.isRollback) {
            // Undone from the row the store wrote, which this edit names.
            prepared.set(tx.hash, mark(storeEdit(account, tx.hash, tokenId, null, ctx.height)))
            continue
        }
        if (storageType !== "onchain") {
            ctx.refuse(tx, `tlsn_store storage "${String(storageType)}" is refused; only onchain is stored`)
            continue
        }
        if (typeof proof !== "string") {
            ctx.refuse(tx, "tlsn_store carries no proof")
            continue
        }
        const verdict = verifyStoredPresentation({
            proof,
            sender: account,
            requestTxHash: tokenId,
            tip,
            blockTimeSec,
        })
        if (verdict.ok === false) {
            ctx.refuse(tx, `tlsn_store presentation refused: ${verdict.reason}`)
            continue
        }
        prepared.set(tx.hash, mark(storeEdit(account, tx.hash, tokenId, verdict, ctx.height)))
    }
    return prepared
}

function storeEdit(
    account: string,
    txhash: string,
    tokenId: string,
    facts: { attestationId: string; serverName: string; attestedTimeSec: number; canonicalProof: string } | null,
    height: number,
): GCREditTlsnVerifiedStore {
    return {
        type: "tlsnotary",
        operation: "verifiedStore",
        account,
        txhash,
        isRollback: false,
        data: {
            tokenId,
            proof: facts?.canonicalProof ?? "",
            storageType: "onchain",
            attestationId: facts?.attestationId ?? "",
            serverName: facts?.serverName ?? "",
            attestedTimeSec: facts?.attestedTimeSec ?? 0,
            storedAtHeight: height,
        },
    }
}

function withEdits(tx: Transaction, edits: GCREdit[]): Transaction {
    return Object.assign(Object.create(Object.getPrototypeOf(tx)), tx, {
        content: { ...tx.content, gcr_edits: edits },
    }) as Transaction
}

/** The copy of `tx` the block applies: its edits, then the derived one. */
export function withTlsnEdit(tx: Transaction, edit: GCREditTlsnDerived | undefined): Transaction {
    if (!edit) return tx
    return withEdits(tx, [...(tx.content.gcr_edits ?? []), edit as unknown as GCREdit])
}

/** `tx` without the edits the node derived: the set its signer is bound to. */
export function withoutNodeDerivedTlsnEdits(tx: Transaction): Transaction {
    const edits = tx.content?.gcr_edits
    if (!Array.isArray(edits) || !edits.some(isNodeDerivedTlsnEdit)) return tx
    return withEdits(tx, edits.filter(e => !isNodeDerivedTlsnEdit(e)))
}

/**
 * Admission of one transaction under `tlsnVerified`: the copy to simulate,
 * with its derived edit, or why it is refused. The simulation then judges
 * the token row as the block would. A verifier that cannot run here refuses
 * the transaction at this node only, which is safe: nothing is admitted.
 */
export function tlsnAdmissionCopy(tx: Transaction): { ok: true; tx: Transaction } | { ok: false; reason: string } {
    if (!tlsnVerifiedAtTip() || !nativeOf(tx)) return { ok: true, tx }
    const refusal: { reason?: string } = {}
    let prepared: Map<string, GCREditTlsnDerived>
    try {
        prepared = prepareTlsnTransitions([tx], {
            height: (getSharedState.lastBlockNumber ?? 0) + 1,
            isRollback: false,
            refuse: (_, why) => {
                refusal.reason = why
            },
        })
    } catch (error) {
        return { ok: false, reason: `the TLSNotary verifier cannot run on this node: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (refusal.reason !== undefined) return { ok: false, reason: refusal.reason }
    return { ok: true, tx: withTlsnEdit(tx, prepared.get(tx.hash)) }
}
