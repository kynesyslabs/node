import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import type { GCREdit, Transaction } from "@kynesyslabs/demosdk/types"
import { nftGatingAtTip, SEAT_TX_TYPES } from "@/forks/nftValidatorGatingGate"
import { withoutLegacyGas } from "./legacyGas"

/**
 * The GCR edits a transaction's signed body implies — what every check that
 * regenerates edits compares the shipped ones against.
 *
 * Generation comes from the SDK, except for an atomicWork transaction's Work
 * edits, which the node derives itself. Which edits a Work carries is a
 * consensus rule of this node, so it must not depend on which SDK release
 * the node happens to be built with: an SDK without the atomicWork case
 * would regenerate only the envelope and every valid Work would mismatch.
 * When the SDK does emit the Work edits, its answer is used as is.
 */
export async function generateGcrEdits(
    tx: Transaction,
    nftGating: boolean = nftGatingAtTip(),
): Promise<GCREdit[]> {
    const generated = await GCRGeneration.generate(tx)
    if (nftGating && SEAT_TX_TYPES.has(tx.content?.type as string)) {
        return nftGatedSeatEdits(tx, generated)
    }
    if ((tx.content?.type as string) !== "atomicWork") return generated
    // Derived even when the SDK already emits the Work edits: this is where
    // the node's own rules (a replay carries no transfers, among others)
    // refuse a Work, whichever generation path produced its edits.
    const work = atomicWorkEdits(tx)
    if (generated.some(e => (e.type as string) === "work-attempt")) return generated
    return [...work, ...generated]
}

const WORK_EDIT_TYPES = new Set(["work-attempt", "resource-slot-cas", "storage-program-put"])

/**
 * The edits of one Work, taken from the signed payload in order, with the
 * sender's transfers placed right after the attempt. Only Work edit kinds
 * are taken from the payload: anything else (a balance credit, say) would
 * let a sender sign state changes the Work itself does not own.
 */
export function atomicWorkEdits(tx: Transaction): GCREdit[] {
    const data = tx.content?.data as unknown as [string, Record<string, unknown>] | undefined
    const payload = data?.[1]
    if (!payload || typeof payload !== "object") {
        throw new TypeError("atomicWork transaction carries no payload")
    }
    const edits = payload.edits
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new TypeError("atomicWork.edits must be a non-empty array")
    }
    const transfers = payload.transfers ?? []
    if (!Array.isArray(transfers)) {
        throw new TypeError("atomicWork.transfers must be an array")
    }
    // The attempt leads: the single-winner ledger is keyed on it, and the
    // transfers are placed right after it.
    if ((edits[0] as { type?: unknown })?.type !== "work-attempt") {
        throw new Error("atomicWork.edits must start with its work-attempt")
    }
    // A replay only reads back a Work that already ran and pays no fee, so
    // transfers riding on it would be free and repeatable.
    if ((edits[0] as { attemptClass?: unknown }).attemptClass === "replay" && transfers.length > 0) {
        throw new Error("atomicWork replay carries no transfers")
    }

    const isRollback = false
    const txhash = tx.hash
    const transferEdits: GCREdit[] = []
    for (const t of transfers as { to?: unknown; amount?: unknown }[]) {
        // The recipient becomes the key of a balance credit, so anything that
        // is not an account address would park the funds where no wallet can
        // reach them.
        if (typeof t?.to !== "string" || !/^0x[0-9a-f]{64}$/i.test(t.to)) {
            throw new Error("atomicWork transfer recipient must be a 0x-prefixed 32-byte hex address")
        }
        if (typeof t.amount !== "string" || !/^[1-9]\d*$/.test(t.amount)) {
            throw new Error("atomicWork transfer amount must be a positive integer string")
        }
        const base = { type: "balance", isRollback, txhash, amount: t.amount }
        transferEdits.push(
            { ...base, operation: "remove", account: tx.content.from_ed25519_address } as unknown as GCREdit,
            { ...base, operation: "add", account: t.to } as unknown as GCREdit,
        )
    }

    const out: GCREdit[] = []
    edits.forEach((raw, i) => {
        const type = (raw as { type?: unknown })?.type
        if (typeof type !== "string" || !WORK_EDIT_TYPES.has(type)) {
            throw new Error(`atomicWork.edits[${i}] is not a Work edit`)
        }
        out.push({ ...(raw as object), isRollback, txhash } as unknown as GCREdit)
        if (i === 0) out.push(...transferEdits)
    })
    return out
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/
const ED25519 = /^(0x)?[0-9a-fA-F]{64}$/

function isBase58(value: unknown): value is string {
    return typeof value === "string" && BASE58.test(value)
}

function seatPayload(tx: Transaction): Record<string, unknown> {
    const data = tx.content?.data as unknown as [string, unknown] | undefined
    const payload = data?.[1]
    if (!payload || typeof payload !== "object") {
        throw new TypeError(`${String(tx.content?.type)} transaction carries no payload`)
    }
    return payload as Record<string, unknown>
}

/**
 * The edits of a seat transaction under `nftValidatorGating`, derived here
 * for the same reason as a Work's: the rule is this node's, and an SDK
 * release without it would regenerate edits every valid seat transaction
 * mismatches. Seat transactions pay no gas, the NFT proof of a stake rides
 * on its stake edit, and a challenge evicts the challenged validator. Where
 * the SDK already emits them, its edits come back unchanged.
 */
function nftGatedSeatEdits(tx: Transaction, generated: GCREdit[]): GCREdit[] {
    const type = tx.content?.type as string
    const edits = withoutLegacyGas(generated)
    if (type === "validatorStake") {
        const nft = seatPayload(tx).nft
        if (nft === undefined) return edits
        const proof = nft as Record<string, unknown> | null
        if (!proof || typeof proof !== "object") {
            throw new TypeError("validatorStake.nft must be an object")
        }
        for (const key of ["mint", "owner", "proofTx"] as const) {
            if (!isBase58(proof[key])) {
                throw new TypeError(`validatorStake.nft.${key} must be a base58 string`)
            }
        }
        return edits.map(edit => {
            const e = edit as unknown as Record<string, unknown>
            if (e.type !== "validatorStake" || e.operation !== "stake" || e.nft !== undefined) {
                return edit
            }
            return {
                ...e,
                nft: { mint: proof.mint, owner: proof.owner, proofTx: proof.proofTx },
            } as unknown as GCREdit
        })
    }
    if (type === "validatorChallenge") {
        if (edits.some(e => (e as unknown as { operation?: unknown }).operation === "evict")) {
            return edits
        }
        const p = seatPayload(tx)
        if (typeof p.validator !== "string" || !ED25519.test(p.validator)) {
            throw new TypeError("validatorChallenge.validator must be an ed25519 address")
        }
        if (!isBase58(p.evidenceTx)) {
            throw new TypeError("validatorChallenge.evidenceTx must be a base58 signature")
        }
        if (!isBase58(p.proofTx)) {
            throw new TypeError("validatorChallenge.proofTx must be a base58 signature")
        }
        const evict = {
            type: "validatorStake",
            isRollback: false,
            account: p.validator.startsWith("0x") ? p.validator : `0x${p.validator}`,
            operation: "evict",
            amount: "0",
            evidenceTx: p.evidenceTx,
            proofTx: p.proofTx,
            txhash: tx.hash,
        } as unknown as GCREdit
        return [evict, ...edits]
    }
    return edits
}
