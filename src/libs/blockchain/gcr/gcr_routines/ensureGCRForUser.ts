// ! TODO: This method should create the GCR for a user if it doesn't exist

import HandleGCR from "../handleGCR"
import Datasource from "src/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { validateEd25519Address } from "@kynesyslabs/demosdk/utils"

export default async function ensureGCRForUser(
    pubkey: string,
): Promise<GCRMain> {
    if (!pubkey.startsWith("0x")) {
        pubkey = `0x${pubkey}`
    }

    const isValidPubKey = validateEd25519Address(pubkey)
    if (!isValidPubKey) {
        throw new Error("Invalid public key")
    }

    // TODO Create the GCR for the user if it doesn't exist
    // TODO Create the GCR extended for the user if it doesn't exist
    const db = await Datasource.getInstance()
    const gcrRepository = db.getDataSource().getRepository(GCRMain)

    const gcr = await gcrRepository.findOne({ where: { pubkey } })

    if (!gcr) {
        // Create the GCR for the user
        return await HandleGCR.createAccount(pubkey)
    }

    return gcr
}
