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

/** A committed transaction as the bind check needs it. */
export interface TlsnRequestRecord {
    hash: string
    /** "confirmed" or "failed", as the block recorded it. */
    status: string
    blockNumber: number
    /** ed25519 address of the signer. */
    sender: string
    /** content.type of the transaction. */
    type: string
    /** nativeOperation of a native transaction, else null. */
    nativeOperation: string | null
    /** args[0] of a native transaction (the target URL of a tlsn_request). */
    targetUrl: string | null
}

/**
 * The committed transaction with this hash, or null when the chain holds
 * none. Only transactions of earlier blocks are in the table while a block
 * applies, so the answer is the same on every node applying that block.
 */
export async function findTlsnRequest(hash: string): Promise<TlsnRequestRecord | null> {
    const { getTransactionsRepo } = await import("@/libs/blockchain/chainDb")
    const row = await readState("tlsn_request lookup", () =>
        getTransactionsRepo().findOneBy({ hash }),
    )
    if (!row) return null
    const content = (row.content ?? {}) as {
        type?: unknown
        from?: unknown
        data?: unknown
    }
    const payload = Array.isArray(content.data)
        ? (content.data[1] as { nativeOperation?: unknown; args?: unknown } | undefined)
        : undefined
    const args = Array.isArray(payload?.args) ? payload.args : []
    const sender =
        typeof row.from_ed25519_address === "string" && row.from_ed25519_address
            ? row.from_ed25519_address
            : typeof content.from === "string"
              ? content.from
              : ""
    return {
        hash: row.hash,
        status: String(row.status),
        blockNumber: Number(row.blockNumber),
        sender,
        type: typeof content.type === "string" ? content.type : String(row.type),
        nativeOperation:
            typeof payload?.nativeOperation === "string" ? payload.nativeOperation : null,
        targetUrl: typeof args[0] === "string" ? args[0] : null,
    }
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
