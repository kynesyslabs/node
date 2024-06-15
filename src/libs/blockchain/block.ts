/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki } from "node-forge"

import { BlockContent } from "@kynesyslabs/demosdk/types"

// NOTE Block class
export default class Block {
    number: number
    hash: string
    content: BlockContent
    status: string
    proposer: pki.PublicKey | pki.ed25519.BinaryBuffer
    validation_data: any

    constructor() {
        this.number = null
        this.hash = null // Calculated on the content
        this.status = null
        this.content = {
            ordered_transactions: [],
            encrypted_transactions: [], // REVIEW This should work already as it is not enforced in the database as a field
            per_address_transactions: new Map(), // ?
            web2data: {}, // objects containing hashes of fetched web2data
            previousHash: null,
            timestamp: null,
        }
        this.proposer = null
        this.validation_data = null
    }

    // ANCHOR Getters

    // INFO The header is the smallest placeholder to verify a block health
    getHeader(): any {
        let header = {
            number: this.number,
            hash: this.hash,
            status: this.status,
            previousHash: this.content.previousHash,
            timestamp: this.content.timestamp,
        }
        return header
    }

    // INFO Returning all the encrypted transactions for the block
    getEncryptedTransactions(): any {
        return this.content.encrypted_transactions
    }

    // ANCHOR Setters
}
