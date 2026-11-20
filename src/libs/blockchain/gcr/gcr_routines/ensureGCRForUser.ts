// ! TODO: This method should create the GCR for a user if it doesn't exist

import HandleGCR from "../handleGCR"
import Datasource from "src/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { validateEd25519Address } from "@kynesyslabs/demosdk/utils"
import type { EntityManager } from "typeorm"

function normalizedPubkey(pubkey: string): string {
    if (!pubkey.startsWith("0x")) {
        pubkey = `0x${pubkey}`
    }

    const isValidPubKey = validateEd25519Address(pubkey)
    if (!isValidPubKey) {
        throw new Error("Invalid public key")
    }
    return pubkey
}

/**
 * The account for `pubkey`, created when missing. With `manager`, read and
 * created inside that transaction.
 */
export default async function ensureGCRForUser(
    pubkey: string,
    manager?: EntityManager,
): Promise<GCRMain> {
    pubkey = normalizedPubkey(pubkey)

    // TODO Create the GCR for the user if it doesn't exist
    // TODO Create the GCR extended for the user if it doesn't exist
    const db = await Datasource.getInstance()
    const gcrRepository = manager
        ? manager.getRepository(GCRMain)
        : db.getDataSource().getRepository(GCRMain)

    const gcr = await gcrRepository.findOne({ where: { pubkey } })

    if (!gcr) {
        // Create the GCR for the user
        if (manager) {
            const account = await HandleGCR.createAccount(pubkey, {}, true)
            return await gcrRepository.save(account)
        }
        return await HandleGCR.createAccount(pubkey)
    }

    return gcr
}
