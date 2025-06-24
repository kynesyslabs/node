/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge from "node-forge"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
export default class Confirmation {
    data: {
        validator: forge.pki.ed25519.BinaryBuffer
        tx_hash_validated: string
    }
    signature: {
        type: SigningAlgorithm
        data: string
    }

    constructor() {
        this.data = {
            validator: null,
            tx_hash_validated: null,
        }
        this.signature = null
    }
}
