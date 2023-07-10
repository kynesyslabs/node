const typeorm = require("typeorm")

const BlockSchema = new typeorm.EntitySchema({
    name: "Block",
    columns: {
        id: {
            primary: true,
            type: "int",
            generated: true,
        },
        number: {
            type: "int",
        },
        hash: {
            type: "varchar",
        },
        status: {
            type: "varchar",
        },
        proposer: {
            type: "varchar",
        },
        validation_data: {
            type: "text",
        },
        timestamp: {
            type: "date",
        },
    },
    relations: {
        // define your relations here
    },
})

export default BlockSchema
