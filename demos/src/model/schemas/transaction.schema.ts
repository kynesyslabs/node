const typeorm = require("typeorm")

const TransactionSchema = new typeorm.EntitySchema({
    name: "Transaction",
    columns: {
        id: {
            primary: true,
            type: "int",
            generated: true,
        },
        content: {
            type: "json",
        },
        signature: {
            type: "varchar",
        },
        hash: {
            type: "varchar",
        },
        confirmations: {
            type: "int",
        },
        state_changes: {
            type: "json",
        },
    },
    relations: {
        // define your relations here
    },
})

export default TransactionSchema
