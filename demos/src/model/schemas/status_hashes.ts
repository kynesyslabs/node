/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

const typeorm = require("typeorm")

const StatusHashSchema = new typeorm.EntitySchema({
    name: "Status_Hashes",
    columns: {
        block: {
            primary: true,
            type: "int",
        },
        hash: {
            type: "varcnar",
        },
    },
    relations: {
        // define your relations here
    },
})

export default StatusHashSchema
