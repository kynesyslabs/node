/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge from "node-forge"
import crypto from "crypto"

export default class Hashing {
    static sha256(message: string) {
        const md = forge.sha256.create()
        md.update(message)
        return md.digest().toHex()
    }

    // New: hash exact bytes deterministically
    static sha256Bytes(bytes: Uint8Array) {
        return crypto.createHash("sha256").update(bytes).digest("hex")
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    static sha3_256(message: string | Uint8Array) {
        return crypto
            .createHash("sha3-256")
            .update(Hashing.normalizeInput(message))
            .digest("hex")
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    static sha3_512(message: string | Uint8Array) {
        return crypto
            .createHash("sha3-512")
            .update(Hashing.normalizeInput(message))
            .digest("hex")
    }

    private static normalizeInput(message: string | Uint8Array) {
        if (typeof message === "string") {
            return Buffer.from(message, "utf8")
        }

        return Buffer.from(message)
    }
}
