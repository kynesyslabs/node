import HandleGCR from "../handleGCR"
import Datasource from "src/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { validateEd25519Address } from "@kynesyslabs/demosdk/utils"

/**
 * The account for `pubkey` for a read: a missing one is answered as the
 * fresh account ensureGCRForUser would create, without storing it. A public
 * read that wrote would let anyone grow the account table one query at a
 * time.
 */
export default async function readGCRForUser(pubkey: string): Promise<GCRMain> {
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

    return gcr ?? (await HandleGCR.createAccount(pubkey, {}, true))
}
