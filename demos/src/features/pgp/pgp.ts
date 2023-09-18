import openpgp from "openpgp"
import Chain from "src/libs/blockchain/chain"

export default class PGP {
    constructor() {}

    static async getPGPKeyServer() {
        let result = await Chain.read("SELECT * FROM pgp_key_server")
        return result
    }

    // TODO Add import/export of the key and verification of email
    // TODO Add encryption/decryption of messages


}