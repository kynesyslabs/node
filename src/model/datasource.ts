/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { DataSource } from "typeorm"

import { Blocks } from "./entities/Blocks"
import { Consensus } from "./entities/Consensus"
import { Mempool } from "./entities/Mempool"
import { PgpKeyServer } from "./entities/PgpKeyServer"
import { GCRHashes } from "./entities/GCR/GCRHashes"
import { GCRExtended } from "./entities/GCR/GCRExtended"
import { Transactions } from "./entities/Transactions"
import { Validators } from "./entities/Validators"
//import { Identities } from "./entities/Identities"
import { GlobalChangeRegistry } from "./entities/GCR/GlobalChangeRegistry"
import { GCRSubnetsTxs } from "./entities/GCR/GCRSubnetsTxs"
class Datasource {
    private static instance: Datasource
    private dataSource: DataSource

    private constructor() {
        this.dataSource = new DataSource({
            type: "postgres",
            host: "localhost",
            port: parseInt(process.env.PG_PORT) || 5332,
            username: "demosuser",
            password: "demospassword",
            database: "demos",
            entities: [
                Blocks,
                Transactions,
                Mempool,
                Consensus,
                PgpKeyServer,
                GCRHashes,
                GCRExtended,
                GCRSubnetsTxs,
                Transactions,
                Validators,
                //Identities,
                GlobalChangeRegistry,
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
