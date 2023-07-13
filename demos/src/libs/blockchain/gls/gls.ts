import Chain from "../chain"


export default class GLS {

    // SECTION Getters
    static async getGLSStatusHashTable() {
        return await Chain.read("SELECT * FROM status_hashes")
    }

    static async getGLSStatusNativeTable() {
        return await Chain.read("SELECT * FROM status_native")
    }
    static async getGLSStatusPropertiesTable() {
        return await Chain.read("SELECT * FROM status_properties")
    }
    static async getGLSLastHash() {
        let response = await Chain.read(
            "SELECT hash FROM status_hashes ORDER BY id DESC LIMIT 1",
        )
        return response[0]
    }
    static async getGLSNativeFor(address: string) {
        let response = await Chain.read(
            "SELECT * FROM status_native WHERE address='" + address + "'",
        )
        return response[0]
    }
    static async getGLSPropertiesFor(address: string) {
        return await Chain.read(
            "SELECT * FROM status_properties WHERE address='" + address + "'",
        )
    }
    // !SECTION Getters

	// SECTION Setters

	// !SECTION Setters
}