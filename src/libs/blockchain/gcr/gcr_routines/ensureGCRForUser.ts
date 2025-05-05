// ! TODO: This method should create the GCR for a user if it doesn't exist

import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import HandleGCR from "../handleGCR"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
export default async function ensureGCRForUser(pubkey: string): Promise<GCRMain> {
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
