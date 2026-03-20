import { ILike } from "typeorm"
import Datasource from "src/model/datasource"
import { GCRHashes } from "src/model/entities/GCRv2/GCRHashes"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"

export async function statusOf(
    address: string,
    type: number,
): Promise<GlobalChangeRegistry | GCRExtended | null> {
    if (type === 0) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        return (await gcrRepository.findOneBy({
            publicKey: ILike(address),
        })) as GlobalChangeRegistry
    } else if (type === 1) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        return (await gcrRepository.findOneBy({
            publicKey: ILike(address),
        })) as GlobalChangeRegistry
    }
    return null
}

export async function statusHashAt(blockNumber: number) {
    const db = await Datasource.getInstance()
    const gcrHashesRepository = db.getDataSource().getRepository(GCRHashes)

    const gcrHashesSearch = await gcrHashesRepository.findOneBy({
        block: blockNumber,
    })
    return gcrHashesSearch ? gcrHashesSearch.hash : null
}
