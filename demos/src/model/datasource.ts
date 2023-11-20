/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { DataSource } from "typeorm"

import BlockSchema from "./schemas/block.schema"
import TransactionSchema from "./schemas/transaction.schema"
import MempoolSchema from "./schemas/mempool.schema"

class Datasource {
    private static instance: Datasource
    private dataSource: DataSource

    private constructor() {
        this.dataSource = new DataSource({
            type: "sqlite",
            database: "./data/chain.db",
            entities: [
                BlockSchema,
                TransactionSchema,
                MempoolSchema,
                // Blocks,
                // Consensus,
                // Mempool,
                // PgpKeyServer,
                // ResponseRegistry,
                // StatusHashes,
                // StatusProperties,
                // Transactions,
                // Validators,
            ],
            synchronize: true, // set this to false in production
            logging: false,
        })
    }

    public static async getInstance(): Promise<Datasource> {
        if (!Datasource.instance) {
            Datasource.instance = new Datasource()
            await Datasource.instance.dataSource.initialize()
        }
        return Datasource.instance
    }

    public getDataSource(): DataSource {
        return this.dataSource
    }
}

export default Datasource
