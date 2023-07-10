import { DataSource } from "typeorm"
import BlockSchema from "./schemas/block.schema"
import TransactionSchema from "./schemas/transaction.schema"

class Datasource {
    private static instance: Datasource
    private dataSource: DataSource

    private constructor() {
        this.dataSource = new DataSource({
            type: "sqlite",
            database: "./data/chain.db",
            entities: [BlockSchema, TransactionSchema],
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
