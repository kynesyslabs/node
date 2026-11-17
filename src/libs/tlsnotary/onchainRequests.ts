/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Datasource from "@/model/datasource"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"

/**
 * The on-chain `tlsn_request` tokens of `tlsnVerified`, for everything that
 * must agree with the chain on whether a request may still be used: the
 * store apply, the identity bind check and the proxy.
 *
 * A token is the `gcr_tlsnotary` row a `tlsn_request` wrote at apply: its id
 * is the request tx hash, its owner the sender, its domain the host of the
 * requested URL. It can be used up to and including `expiresAtHeight`.
 */

/** Blocks a request stays usable after the block it landed in: inclusion, attest, then store at about 7 s blocks. */
export const TLSN_REQUEST_TTL_BLOCKS = 500

/** A transaction hash as the chain keys tokens by it: 64 lowercase hex, no prefix. */
export const TLSN_TOKEN_ID = /^[0-9a-f]{64}$/

export interface OnChainTlsnRequest {
    tokenId: string
    owner: string
    domain: string
    status: "pending" | "stored"
    requestHeight: number
    expiresAtHeight: number
}

export type TlsnRequestRefusal =
    | "NOT_FOUND"
    | "OWNER_MISMATCH"
    | "DOMAIN_MISMATCH"
    | "EXPIRED"
    | "ALREADY_STORED"

export interface TlsnRequestExpectation {
    /** The account that must own the request. */
    sender: string
    /** Height the request must still be usable at. */
    height: number
    /** Host the request must have been made for, when the caller has one. */
    domain?: string
    /** Refuse a request whose proof is already stored. */
    pendingOnly?: boolean
}

const sameAccount = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The token a row holds, or null for a row that is not a `tlsnVerified` token (a pre-fork proof). */
export function tlsnRequestOf(row: GCRTLSNotary | null | undefined): OnChainTlsnRequest | null {
    if (!row) return null
    if (row.status !== "pending" && row.status !== "stored") return null
    if (row.requestHeight === null || row.expiresAtHeight === null) return null
    return {
        tokenId: row.tokenId,
        owner: row.owner,
        domain: row.domain,
        status: row.status,
        requestHeight: Number(row.requestHeight),
        expiresAtHeight: Number(row.expiresAtHeight),
    }
}

/**
 * Why `request` cannot be used as `expect` says, or null when it can. Pure,
 * so a consensus path judges the row it loaded with the block's caches.
 */
export function tlsnRequestRefusal(
    request: OnChainTlsnRequest | null,
    expect: TlsnRequestExpectation,
): TlsnRequestRefusal | null {
    if (!request) return "NOT_FOUND"
    if (!sameAccount(request.owner, expect.sender)) return "OWNER_MISMATCH"
    if (expect.domain !== undefined && request.domain !== expect.domain.toLowerCase()) {
        return "DOMAIN_MISMATCH"
    }
    if (expect.height > request.expiresAtHeight) return "EXPIRED"
    if (expect.pendingOnly && request.status !== "pending") return "ALREADY_STORED"
    return null
}

/** The on-chain request with this tx hash, as the last committed block left it. */
export async function getOnChainTlsnRequest(requestTxHash: string): Promise<OnChainTlsnRequest | null> {
    const tokenId = requestTxHash.toLowerCase().replace(/^0x/, "")
    if (!TLSN_TOKEN_ID.test(tokenId)) return null
    const db = await Datasource.getInstance()
    const row = await db.getDataSource().getRepository(GCRTLSNotary).findOneBy({ tokenId })
    return tlsnRequestOf(row)
}

/**
 * Whether there is an on-chain `tlsn_request` with hash `requestTxHash` by
 * `expect.sender`, usable at `expect.height`: the committed state's answer,
 * for the proxy and for admission. Apply-time callers judge the rows the
 * block loaded with {@link tlsnRequestRefusal} instead.
 */
export async function findLiveTlsnRequest(
    requestTxHash: string,
    expect: TlsnRequestExpectation,
): Promise<{ ok: true; request: OnChainTlsnRequest } | { ok: false; reason: TlsnRequestRefusal }> {
    const request = await getOnChainTlsnRequest(requestTxHash)
    const reason = tlsnRequestRefusal(request, expect)
    return reason === null && request ? { ok: true, request } : { ok: false, reason: reason ?? "NOT_FOUND" }
}
