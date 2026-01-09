/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki } from "node-forge"

import { BlockContent, Block as BlockType } from "@kynesyslabs/demosdk/types"
import { Peer } from "../peer"

// NOTE Block class
export default class Block implements BlockType {
    id: number
    number: number
    hash: string
    content: BlockContent
    status:  "derived" | "confirmed"
    proposer: pki.PublicKey | pki.ed25519.BinaryBuffer
    next_proposer: string
    validation_data: { signatures: { [key: string]: string } }

    constructor() {
        this.number = null
        this.hash = null // Calculated on the content
        this.status = null
        this.next_proposer = ""
        this.content = {
            ordered_transactions: [],
            encrypted_transactions_hashes: new Map(), // REVIEW This should work already as it is not enforced in the database as a field
            per_address_transactions: new Map(), // ?
            web2data: {}, // objects containing hashes of fetched web2data
            previousHash: null,
            timestamp: null,
            peerlist: [],
            l2ps_partecipating_nodes: new Map(),
            l2ps_banned_nodes: new Map(),
            native_tables_hashes: {
                native_gcr: "placeholder",
                native_subnets_txs: "placeholder",
                native_tlsnotary: "placeholder",
            },
        }
        this.proposer = null
        this.validation_data = { signatures: {} }
    }

    // ANCHOR Getters

    // INFO The header is the smallest placeholder to verify a block health
    getHeader(): any {
        const header = {
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
        return this.content.encrypted_transactions_hashes
    }

    // ANCHOR Setters
}
