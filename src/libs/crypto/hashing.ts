/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import crypto from "crypto"

export default class Hashing {
    static sha256(message: string) {
        return crypto.createHash("sha256").update(message).digest("hex")
    }

    // New: hash exact bytes deterministically
    static sha256Bytes(bytes: Uint8Array) {
        return crypto.createHash("sha256").update(bytes).digest("hex")
    }
}
