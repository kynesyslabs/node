/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

const typeorm = require("typeorm")

const BlockSchema = new typeorm.EntitySchema({
    name: "Blocks",
    columns: {
        id: {
            primary: true,
            type: "int",
            generated: true,
        },
        content: {
            type: "json",
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
