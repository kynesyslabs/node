/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { DataSource } from "typeorm"

import { Blocks } from "./entities/Blocks"
import { Transactions } from "./entities/Transactions"
import { Mempool } from "./entities/Mempool"
import { Consensus } from "./entities/Consensus"

class Datasource {
    private static instance: Datasource
    private dataSource: DataSource

    private constructor() {
        this.dataSource = new DataSource({
            type: "sqlite",
            database: "./data/chain.db",
            entities: [
                Blocks,
                Transactions,
                Mempool,
                Consensus,
                // Mempool,
                // PgpKeyServer,
                // ResponseRegistry,
                // StatusHashes,
                // StatusProperties,
                // Transactions,
                // Validators,
            ],
            synchronize: true, // set this to false in production
            logging: true,
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
