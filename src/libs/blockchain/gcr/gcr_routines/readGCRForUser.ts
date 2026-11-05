import HandleGCR from "../handleGCR"
import Datasource from "src/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { validateEd25519Address } from "@kynesyslabs/demosdk/utils"

/** An account as a read answers it; an unstored one has no referral code yet. */
export type ReadAccount = Omit<GCRMain, "referralInfo"> & {
    referralInfo: Omit<GCRMain["referralInfo"], "referralCode"> & {
        referralCode: string | null
    }
}

/**
 * The account for `pubkey` for a read: a missing one is answered as the
 * fresh account ensureGCRForUser would create, without storing it. A public
 * read that wrote would let anyone grow the account table one query at a
 * time.
 */
export default async function readGCRForUser(
    pubkey: string,
): Promise<ReadAccount> {
    if (!pubkey.startsWith("0x")) {
        pubkey = `0x${pubkey}`
    }
    if (!validateEd25519Address(pubkey)) {
        throw new Error("Invalid public key")
    }

    const db = await Datasource.getInstance()
    const gcr = await db
        .getDataSource()
        .getRepository(GCRMain)
        .findOne({ where: { pubkey } })
    if (gcr) return gcr

    const fresh = await HandleGCR.createAccount(pubkey, {}, true)
    // Referral lookups only find stored codes, so the generated one would be
    // refused until the account exists. The object keeps its shape.
    return {
        ...fresh,
        referralInfo: { ...fresh.referralInfo, referralCode: null },
    }
}
