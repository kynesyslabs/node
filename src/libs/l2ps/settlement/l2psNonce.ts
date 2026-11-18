/**
 * The per-subnet L2PS nonce an account keeps next to its L1 nonce
 * (`gcr_main.l2psNonces`, subnet uid -> nonce). Private transfers settle
 * against it and never against the L1 nonce, so an L1 transaction does not
 * wait for a private transfer to settle.
 * Spec: docs/design/l2ps-zk-settlement.md, "L2PS nonce".
 *
 * Subnet uids come off the wire and become object keys, so every read and
 * write goes through own properties: a uid such as "__proto__" or
 * "constructor" must read 0 and store as a plain entry, never reach the
 * prototype, or a nonce that never advances would let a signed transfer
 * settle twice.
 */

export type L2PSNonces = Record<string, number>

/** The node-derived edit a settlement batch moves an L2PS nonce with. */
export interface GCREditL2PSNonce {
    type: "l2psNonce"
    operation: "add" | "remove"
    account: string
    l2psUid: string
    amount: number
    txhash: string
    isRollback: boolean
}

export const L2PS_NONCE_EDIT = "l2psNonce"

export function isL2PSNonceEdit(edit: unknown): edit is GCREditL2PSNonce {
    return (edit as { type?: unknown } | null)?.type === L2PS_NONCE_EDIT
}

/** The account's L2PS nonce in a subnet; an absent account, map or entry reads 0. */
export function l2psNonceOf(
    account: { l2psNonces?: unknown } | null | undefined,
    l2psUid: string,
): number {
    const nonces = account?.l2psNonces
    if (typeof nonces !== "object" || nonces === null) return 0
    if (!Object.prototype.hasOwnProperty.call(nonces, l2psUid)) return 0
    const value = (nonces as Record<string, unknown>)[l2psUid]
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * A copy of `nonces` with `l2psUid` set to `value`, or removed when 0, so an
 * account that never settled and one whose settlement was undone store the
 * same row. A fresh object, so the ORM sees the column change.
 */
export function withL2PSNonce(nonces: unknown, l2psUid: string, value: number): L2PSNonces {
    const next: L2PSNonces = {}
    if (typeof nonces === "object" && nonces !== null) {
        for (const key of Object.keys(nonces)) {
            if (key === l2psUid) continue
            Object.defineProperty(next, key, {
                value: (nonces as Record<string, unknown>)[key],
                enumerable: true,
                writable: true,
                configurable: true,
            })
        }
    }
    if (value !== 0) {
        Object.defineProperty(next, l2psUid, { value, enumerable: true, writable: true, configurable: true })
    }
    return next
}

/** Whether any subnet nonce of the account has moved. */
export function hasL2PSNonces(account: { l2psNonces?: unknown } | null | undefined): boolean {
    const nonces = account?.l2psNonces
    if (typeof nonces !== "object" || nonces === null) return false
    return Object.keys(nonces).some(key => l2psNonceOf(account, key) !== 0)
}
