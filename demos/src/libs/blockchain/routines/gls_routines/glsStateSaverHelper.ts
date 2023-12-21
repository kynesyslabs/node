// INFO At the end of each block forging (aka at the end of the consensus mechanism), each node operator will be able to get this GLS state hash
// which is set by the validators during the consensus and is an hash of all the applicable operations for that block.
import Chain from "../../chain"
import { StatusHashes } from "src/model/entities/StatusHashes"
import Datasource from "src/model/datasource"
import Hashing from "src/libs/crypto/hashing"
import { Operation } from "../executeOperations"
import { Hash } from "crypto"

// REVIEW This could be avoided probably, by using inline hashes instead of hashing the whole table
// TODO Expand the operation registry (if any) to support inlining of hashes into GLS states.

// INFO Take the ordered list of operations from the consensus mechanism and hash it
export default class glsStateSave {
    constructor() {}

    static async postConsensusEngraving(ops: Operation[]) {
        let hashed_ops = Hashing.sha256(JSON.stringify(ops)) // REVIEW Stringify?
        const db = await Datasource.getInstance()
        const StatusHashesRepository = db
                .getDataSource()
                .getRepository(StatusHashes)
        // Adding the hash to the database
        await StatusHashesRepository.insert(
            StatusHashesRepository.create({
                hash: hashed_ops,
            }),
        ) // REVIEW Test it
    }

    static getLastConsenusStateHash() {
        // TODO Get the last consensus state hash from the database (see the above method)
    }
}
