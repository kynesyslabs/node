const { DataSource } = require("typeorm")
const { BlockSchema } = require("./schemas/block.schema.js")
const { TransactionSchema } = require("./schemas/transaction.schema.js")

class Datasource {
    constructor() {
        if (Datasource.exists) {
            return Datasource.instance
        }
        this.init()
        Datasource.instance = this
        Datasource.exists = true
        return this
    }

    async init() {
        this.dataSource = await new DataSource({
            type: "sqlite",
            database: "./data/chain.db",
            entities: [BlockSchema, TransactionSchema],
            synchronize: true, // set this to false in production
            logging: false,
        }).initialize()
    }

    getDataSource() {
        return this.dataSource
    }
}

module.exports = new Datasource()
