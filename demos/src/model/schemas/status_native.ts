/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

const typeorm = require("typeorm")

const StatusNativeSchema = new typeorm.EntitySchema({
    name: "Status_Native",
    columns: {
        address: {
            primary: true,
            type: "varchar",
        },
        balance: {
            type: "int",
        },
        nonce: {
            type: "int",
        },
        tx_list: {
            type: "json",
        },
    },
    relations: {
        // define your relations here
    },
})

export default StatusNativeSchema
