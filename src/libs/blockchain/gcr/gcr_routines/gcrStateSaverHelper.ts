// INFO At the end of each block forging (aka at the end of the consensus mechanism), each node operator will be able to get this GCR state hash
import { Hash } from "crypto"
import Hashing from "src/libs/crypto/hashing"
import Datasource from "src/model/datasource"
import { GCRHashes } from "src/model/entities/GCRv2/GCRHashes"

// which is set by the validators during the consensus and is an hash of all the applicable operations for that block.
import Chain from "../../chain"
import { Operation } from "@kynesyslabs/demosdk/types"
import { GCRTracker } from "src/model/entities/GCR/GCRTracker"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"

// REVIEW This could be avoided probably, by using inline hashes instead of hashing the whole table
// TODO Expand the operation registry (if any) to support inlining of hashes into GCR states.

// INFO Take the ordered list of operations from the consensus mechanism and hash it
export default class GCRStateSaverHelper {
    constructor() {}

    static getLastConsenusStateHash() {
        // TODO Get the last consensus state hash from the database (see the below methods)
    }

    // Updating the GCR tracker for a given public key
    static async updateGCRTracker(publicKey: string) {
        // TODO Update the GCR tracker for a given public key
        const db = await Datasource.getInstance()
        const gcrTrackerRepository = db
            .getDataSource()
            .getRepository(GCRTracker)
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        const userData = await gcrRepository.findOne({
            where: { publicKey: publicKey },
        })
        if (!userData) {
            throw new Error("User data not found")
        }
        const hash = Hashing.sha256(JSON.stringify(userData))
        // Creating or updating the GCR tracker using upsert
        await gcrTrackerRepository.upsert(
            {
                publicKey: publicKey,
                hash: hash,
            },
            {
                conflictPaths: ["publicKey"],
            },
        )
    }
}
