/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki } from "node-forge"
import BlockContent from "./types/blocks"

// NOTE Block class
export default class Block {
    number: number
    hash: string
    status: string
    content: BlockContent // TODO
    proposer: pki.PublicKey | pki.ed25519.BinaryBuffer
    validation_data: any
    timestamp: number

    constructor() {
        this.number = null
        this.hash = null // Calculated on the content
        this.status = null
        this.content = {
            ordered_transactions: [],
            per_address_transactions: new Map<string, string[]>(),
            web2data: {}, // objects containing hashes of fetched web2data
            previousHash: null,
        }
        this.proposer = null
        this.validation_data = null
        this.timestamp = null
    }

    // ANCHOR Getters

    // ANCHOR Setters
}
