/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { sha256 } from "node-forge"

export default class Hashing {
    static sha256(message: string) {
        const md = sha256.create()
        md.update(message)
        return md.digest().toHex()
    }

        
}
