import GCROperation from "src/libs/blockchain/gcr/types/GCROperations"
import { EntityTarget, Repository, FindOptionsOrder } from "typeorm"
import Datasource from "../../../../model/datasource"
import Hashing from "src/libs/crypto/hashing"
import { GCRSubnetsTxs } from "../../../../model/entities/GCRv2/GCRSubnetsTxs"
import { GlobalChangeRegistry } from "../../../../model/entities/GCR/GlobalChangeRegistry"
import { GCRHashes } from "../../../../model/entities/GCRv2/GCRHashes"
import { GCRTracker } from "src/model/entities/GCR/GCRTracker"

// TODO Call the GCR methods to apply the operation to the GCR tables
// TODO See if we can have a diff of the DB tables and apply only the changes

export default async function applyGCROperation(
    operation: GCROperation,
): Promise<boolean> {
    // Get the GCR tables
    const success = true
    const db = await Datasource.getInstance()
    const gcrTrackerRepository: Repository<GCRTracker> = db
        .getDataSource()
        .getRepository(GCRTracker)
    const gcrHashesRepository: Repository<GCRHashes> = db
        .getDataSource()
        .getRepository(GCRHashes)
    const gcrSubnetsTxsRepository: Repository<GCRSubnetsTxs> = db
        .getDataSource()
        .getRepository(GCRSubnetsTxs)
    const globalChangeRegistryRepository: Repository<GlobalChangeRegistry> = db
        .getDataSource()
        .getRepository(GlobalChangeRegistry)
    // TODO Examine the operation and apply it to the GCR tables
    // TODO Update the GCR hashes
    // ? Is there a way to return a diff of the GCR tables?
    return success
}
