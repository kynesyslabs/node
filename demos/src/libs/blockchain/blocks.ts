import { pki } from "node-forge"
import BlockContent from "./types/blocks"

// NOTE Block class
export default class Block {
    number: number
    hash: string
    status: string
    content: BlockContent // TODO
    proposer: pki.PublicKey
    validation_data: Buffer
    timestamp: number

    constructor() {
        this.number = null
        this.hash = null // Calculated on the content
        this.status = null
        this.content = {
            transactions: [],
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
