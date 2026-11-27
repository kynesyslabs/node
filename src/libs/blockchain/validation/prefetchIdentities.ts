import { In } from "typeorm"
import { Transaction } from "@kynesyslabs/demosdk/types"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { SavedPqcIdentity } from "@/model/entities/types/IdentityTypes"
import Datasource from "@/model/datasource"
import { IdentityPrefetchError } from "./identityPrefetchError"
import type { IdentityHintMap } from "./types"

function normalizePubkey(addr: string): string {
    return addr.startsWith("0x") ? addr : `0x${addr}`
}

/**
 * Whether the validator will ask an identity record for `tx`: signed by a PQC
 * key alone, with a signer address that can be looked up.
 *
 * This judges nothing: each transaction gets its own verdict from
 * validateTx. A record is fetched only for a signature type and a signer
 * address that are strings, the only form in which the one names a key type
 * and the other an account.
 */
function needsIdentityRecord(tx: Transaction): boolean {
    const type = (tx as { signature?: { type?: unknown } | null } | null)
        ?.signature?.type
    return (
        typeof type === "string" &&
        type !== "ed25519" &&
        !tx.ed25519_signature &&
        typeof tx.content?.from_ed25519_address === "string"
    )
}

/**
 * Pre-fetches the single PQC identity record each transaction needs to
 * validate without hitting the DB inside the validator. Mirrors the lookup
 * `TxUtils.validateSignature` performs via `IdentityManager.getIdentities`,
 * but goes straight to the repository so unknown signers do NOT cause an
 * empty `GCRMain` row to be created (which `ensureGCRForUser` would do).
 *
 * Returns a map keyed by `tx.hash`. Only PQC transactions without an
 * ed25519 co-signature are present; all other tx hashes are absent and
 * callers should treat that as a `null` hint.
 */
export default async function prefetchIdentities(
    txs: Transaction[],
): Promise<IdentityHintMap> {
    const needIdentity = txs.filter(needsIdentityRecord)
    if (needIdentity.length === 0) return {}

    const addresses = new Set<string>()
    for (const tx of needIdentity) {
        addresses.add(normalizePubkey(tx.content.from_ed25519_address))
    }

    let rows: Pick<GCRMain, "pubkey" | "identities">[]
    try {
        const repo = (await Datasource.getInstance())
            .getDataSource()
            .getRepository(GCRMain)
        rows = await repo.find({
            where: { pubkey: In(Array.from(addresses)) },
            select: ["pubkey", "identities"],
        })
    } catch (error) {
        throw new IdentityPrefetchError(error)
    }

    const pqcByPubkey = new Map<string, Record<string, SavedPqcIdentity[]>>()
    for (const row of rows) {
        pqcByPubkey.set(row.pubkey, row.identities?.pqc ?? {})
    }

    const hints: IdentityHintMap = {}
    for (const tx of needIdentity) {
        const pubkey = normalizePubkey(tx.content.from_ed25519_address)
        // Only a list the account itself holds under this very type: a name
        // every object answers to is not a key's records.
        const byType = pqcByPubkey.get(pubkey)
        const type = tx.signature.type
        const entries =
            byType !== undefined && Object.hasOwn(byType, type)
                ? byType[type]
                : undefined
        hints[tx.hash] = Array.isArray(entries)
            ? (entries.find(e => e?.address === tx.content.from) ?? null)
            : null
    }
    return hints
}
