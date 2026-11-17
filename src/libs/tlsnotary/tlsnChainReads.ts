/**
 * The chain state the TLSNotary identity rules read. Kept in one module so
 * the rules themselves stay pure and a test can stand in for the database.
 *
 * Every read goes through readState: a read that fails says nothing about
 * the transaction, so inside block apply it must stop the block (as any
 * other StateReadError does) instead of failing the transaction on this node
 * only.
 */
import { StateReadError, readState } from "@/libs/blockchain/gcr/stateReadError"
import { web2UserIdLookupKey } from "@/libs/identity/web2UserId"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { TLSN_TOKEN_ID, tlsnRequestOf } from "./onchainRequests"

/**
 * The token row of the `tlsn_request` with this hash: the one the block
 * being applied holds in `held` when it holds it (written or used earlier in
 * the block), else the one the last committed block left, or null. Only
 * `tlsnVerified` tokens count; a pre-fork proof row is no request.
 */
export async function findTlsnRequest(
    hash: string,
    held?: ReadonlyMap<string, GCRTLSNotary | null>,
): Promise<GCRTLSNotary | null> {
    if (!TLSN_TOKEN_ID.test(hash)) return null
    if (held?.has(hash)) {
        const row = held.get(hash) ?? null
        return tlsnRequestOf(row) ? row : null
    }
    const { dataSource } = await import("@/model/datasource")
    const row = await readState("tlsn_request token", () =>
        dataSource.getRepository(GCRTLSNotary).findOneBy({ tokenId: hash }),
    )
    return tlsnRequestOf(row) ? row : null
}

/**
 * The token row an identity link of transaction `txhash` used, for its
 * undo: held by the block when it holds it, else as committed.
 */
export async function findTlsnLinkedToken(
    txhash: string,
    held?: ReadonlyMap<string, GCRTLSNotary | null>,
): Promise<GCRTLSNotary | null> {
    for (const row of held?.values() ?? []) {
        if (row && row.status === "linked" && row.txhash === txhash) return row
    }
    const { dataSource } = await import("@/model/datasource")
    const row = await readState("tlsn linked token", () =>
        dataSource.getRepository(GCRTLSNotary).findOneBy({ txhash, status: "linked" }),
    )
    // The block's copy is the current one: a row it holds and changed is
    // not the committed one any more.
    if (!row || held?.has(row.tokenId)) return null
    return row
}

export interface TlsnLinkQuery {
    context: string
    userId: string
    attestationId: string
    /** The account linking; its own links are judged by the caller. */
    account: string
    /** Accounts whose current state the caller holds in memory. */
    skip: readonly string[]
}

export interface TlsnLinkHits {
    /** Another account has a link with this userId in this context. */
    userIdLinked: boolean
    /** Some account stores a link made from this attestation. */
    attestationUsed: boolean
}

// A bucket that is not an array (never written by apply, but possible in an
// old row) reads as empty instead of failing the query on every node.
const BUCKET = (alias: string) =>
    `CASE WHEN jsonb_typeof(${alias}.identities->'web2'->:context) = 'array' ` +
    `THEN ${alias}.identities->'web2'->:context ELSE '[]'::jsonb END`

/** Stored links of other accounts that a new TLSN link must not repeat. */
export async function findTlsnLinkHits(q: TlsnLinkQuery): Promise<TlsnLinkHits> {
    const { dataSource } = await import("@/model/datasource")
    const { GCRMain } = await import("@/model/entities/GCRv2/GCR_Main")
    const repo = dataSource.getRepository(GCRMain)
    const base = () => {
        const qb = repo.createQueryBuilder("gcr").select("gcr.pubkey")
        if (q.skip.length > 0) {
            qb.where("gcr.pubkey NOT IN (:...skip)", { skip: [...q.skip] })
        } else {
            qb.where("TRUE")
        }
        return qb
    }
    const userIdRow = await readState("tlsn linked userId", () =>
        base()
            .andWhere("gcr.pubkey != :account", { account: q.account })
            .andWhere(
                `EXISTS (SELECT 1 FROM jsonb_array_elements(${BUCKET("gcr")}) AS l WHERE l->>'userId' = :userId)`,
                { context: q.context, userId: web2UserIdLookupKey(q.userId) },
            )
            .getOne(),
    )
    const attestationRow = await readState("tlsn attestation id", () =>
        base()
            .andWhere(
                `EXISTS (SELECT 1 FROM jsonb_array_elements(${BUCKET("gcr")}) AS l WHERE l->>'attestationId' = :attestationId)`,
                { context: q.context, attestationId: q.attestationId },
            )
            .getOne(),
    )
    return { userIdLinked: userIdRow !== null, attestationUsed: attestationRow !== null }
}

/** Timestamp, in seconds, of the block at this node's tip. */
export async function tipBlockTimestampSec(): Promise<number> {
    const { getLastBlock } = await import("@/libs/blockchain/chainBlocks")
    const block = await readState("tip block", () => getLastBlock())
    const ts = Number(block?.content?.timestamp)
    if (!Number.isFinite(ts)) {
        throw new StateReadError("tip block", "it has no timestamp")
    }
    return Math.floor(ts)
}
