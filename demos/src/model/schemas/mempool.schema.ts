/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

const typeorm = require("typeorm")

const MempoolSchema = new typeorm.EntitySchema({
    name: "Mempool",
    columns: {
        number: {
            type: "int",
            nullable: true,
        },
        current: {
            type: "int",
            nullable: true,
        },
        transactions: {
            type: "text",
            nullable: true,
        },
        proposedBlock: {
            type: "text",
            nullable: true,
        },
    },
    relations: {
        // define your relations here
    },
})

export default MempoolSchema
