/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { DataSource } from "typeorm"

import { Blocks } from "./entities/Blocks.js"
import { Consensus } from "./entities/Consensus.js"
import { MempoolTx } from "./entities/Mempool.js"
import { PgpKeyServer } from "./entities/PgpKeyServer.js"
import { Transactions } from "./entities/Transactions.js"
import { Validators } from "./entities/Validators.js"
import { GlobalChangeRegistry } from "./entities/GCR/GlobalChangeRegistry.js"
import { GCRHashes } from "./entities/GCRv2/GCRHashes.js"
import { GCRSubnetsTxs } from "./entities/GCRv2/GCRSubnetsTxs.js"
import { GCRMain } from "./entities/GCRv2/GCR_Main.js"
import { GCRTracker } from "./entities/GCR/GCRTracker.js"

export const dataSource = new DataSource({
    type: "postgres",
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT) || 5332,
    username: process.env.PG_USER || "demosuser",
    password: process.env.PG_PASSWORD || "demospassword",
    database: process.env.PG_DATABASE || "demos",
    migrations: ["../migrations/*.{ts,js}"],
    entities: [
        Blocks,
        MempoolTx,
        Consensus,
        PgpKeyServer,
        GCRHashes,
        GCRSubnetsTxs,
        Transactions,
        Validators,
        GlobalChangeRegistry,
        GCRTracker,
        GCRMain,
    ],
    synchronize: true,
    logging: false,
})


class Datasource {
    private static instance: Datasource
    private dataSource: DataSource

    private constructor() {
        this.dataSource = dataSource
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
