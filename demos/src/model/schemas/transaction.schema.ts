/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

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
