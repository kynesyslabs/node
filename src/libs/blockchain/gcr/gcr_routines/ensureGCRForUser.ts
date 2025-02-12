// ! TODO: This method should create the GCR for a user if it doesn't exist

import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import HandleGCR from "../handleGCR"
export default async function ensureGCRForUser(
    publicKey: string,
): Promise<any> {
    // TODO Create the GCR for the user if it doesn't exist
    // TODO Create the GCR extended for the user if it doesn't exist
    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GlobalChangeRegistry)

    let gcr = await GCRRepository.findOne({ where: { publicKey } })

    if (!gcr) {
        // Create the GCR for the user
        await HandleGCR.createAccount(publicKey)
        gcr = await GCRRepository.findOne({ where: { publicKey } })
    }

    return gcr
}
