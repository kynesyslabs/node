import { In } from "typeorm"
import { Transaction } from "@kynesyslabs/demosdk/types"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { SavedPqcIdentity } from "@/model/entities/types/IdentityTypes"
import Datasource from "@/model/datasource"
import type { IdentityHintMap } from "./types"

function normalizePubkey(addr: string): string {
    return addr.startsWith("0x") ? addr : `0x${addr}`
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
    const needIdentity = txs.filter(
        t => t.signature.type !== "ed25519" && !t.ed25519_signature,
    )
    if (needIdentity.length === 0) return {}

    const addresses = new Set<string>()
    for (const tx of needIdentity) {
        addresses.add(normalizePubkey(tx.content.from_ed25519_address))
    }

    const repo = (await Datasource.getInstance())
        .getDataSource()
        .getRepository(GCRMain)
    const rows = await repo.find({
        where: { pubkey: In(Array.from(addresses)) },
        select: ["pubkey", "identities"],
    })

    const pqcByPubkey = new Map<string, Record<string, SavedPqcIdentity[]>>()
    for (const row of rows) {
        pqcByPubkey.set(row.pubkey, row.identities?.pqc ?? {})
    }

    const hints: IdentityHintMap = {}
    for (const tx of needIdentity) {
        const pubkey = normalizePubkey(tx.content.from_ed25519_address)
        const entries = pqcByPubkey.get(pubkey)?.[tx.signature.type] ?? []
        hints[tx.hash] =
            entries.find(e => e.address === tx.content.from) ?? null
    }
    return hints
}
