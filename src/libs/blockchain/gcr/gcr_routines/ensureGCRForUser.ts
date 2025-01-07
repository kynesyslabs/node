// ! TODO: This method should create the GCR for a user if it doesn't exist

import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"

export default async function ensureGCRForUser(
    publicKey: string,
): Promise<any> {
    // TODO Create the GCR for the user if it doesn't exist
    // TODO Create the GCR extended for the user if it doesn't exist
    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GlobalChangeRegistry)

    const gcr = await GCRRepository.findOne({ where: { publicKey } })

    if (!gcr) {
        const data = {
            publicKey: publicKey,
            details: {
                content: {
                    balance: 0,
                    identities: {
                        xm: {
                            eth: {
                                sepolia: [],
                                mainnet: [],
                            },
                        },
                        web2: {},
                    },
                    txs: [],
                    nonce: 0,
                },
            },
            extended: {
                tokens: [],
                nfts: [],
                xm: [],
                web2: [],
                other: [],
            },
        }
        return await GCRRepository.save(data)
    }

    return gcr
}
