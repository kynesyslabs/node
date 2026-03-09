/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { DataSource } from "typeorm"
import { Config } from "src/config"

import { Blocks } from "./entities/Blocks.js"
import { Consensus } from "./entities/Consensus.js"
import { MempoolTx } from "./entities/Mempool.js"
import { PgpKeyServer } from "./entities/PgpKeyServer.js"
import { Transactions } from "./entities/Transactions.js"
import { GCRHashes } from "./entities/GCRv2/GCRHashes.js"
import { GCRSubnetsTxs } from "./entities/GCRv2/GCRSubnetsTxs.js"
import { GCRMain } from "./entities/GCRv2/GCR_Main.js"
import { GCRAssignedTx } from "./entities/GCRv2/GCRAssignedTx.js"
import { GCRTLSNotary } from "./entities/GCRv2/GCR_TLSNotary.js"
import { GCRStorageProgram } from "./entities/GCRv2/GCR_StorageProgram.js"
// ZK Identity entities
import { IdentityCommitment } from "./entities/GCRv2/IdentityCommitment.js"
import { UsedNullifier } from "./entities/GCRv2/UsedNullifier.js"
import { MerkleTreeState } from "./entities/GCRv2/MerkleTreeState.js"
// L2PS entities
import { OfflineMessage } from "./entities/OfflineMessages"
import { L2PSHash } from "./entities/L2PSHashes.js"
import { L2PSMempoolTx } from "./entities/L2PSMempool.js"
import { L2PSTransaction } from "./entities/L2PSTransactions.js"
import { L2PSProof } from "./entities/L2PSProofs.js"
// Stackable-genesis governance entities
import { NetworkUpgrade } from "./entities/NetworkUpgrade.js"
import { NetworkUpgradeVote } from "./entities/NetworkUpgradeVote.js"
// Hard-fork bookkeeping (P3b — DEM→OS denomination migration)
import { ForkState } from "./entities/ForkState.js"
import { Validators } from "./entities/Validators.js"
// L2PS Messaging
import { L2PSMessage } from "@/features/l2ps-messaging/entities/L2PSMessage"

export const dataSource = new DataSource({
    type: "postgres",
    host: Config.getInstance().database.host,
    port: Config.getInstance().database.port,
    username: Config.getInstance().database.user,
    password: Config.getInstance().database.password,
    database: Config.getInstance().database.database,
    migrations: ["src/migrations/*.{ts,js}"],
    migrationsRun: true,
    entities: [
        Blocks,
        MempoolTx,
        Consensus,
        PgpKeyServer,
        GCRHashes,
        GCRSubnetsTxs,
        Transactions,
        GCRMain,
        GCRAssignedTx,
        GCRTLSNotary,
        GCRStorageProgram,
        Validators,
        // ZK Identity entities
        IdentityCommitment,
        UsedNullifier,
        MerkleTreeState,
        // L2PS entities
        OfflineMessage,
        L2PSHash,
        L2PSMempoolTx,
        L2PSTransaction,
        L2PSProof,
        // Stackable-genesis governance entities
        NetworkUpgrade,
        NetworkUpgradeVote,
        // Hard-fork bookkeeping (P3b)
        ForkState,
        // L2PS Messaging
        L2PSMessage,
    ],
    synchronize: false,
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
