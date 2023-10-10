// INFO Defining the structure of a valid Genesis block
import Chain from "../chain"
import Block from "../blocks"
/* INFO
 *
 * block, and are not present in the following ones.
 *
 */

// SECTION Primitives

export interface GenesisImmutableProperties {
    id: number
    name: string
    currency: string
}

export interface GenesisMutableProperties {
    minBlocksForValidationOnlineStatus: number
}

export interface GenesisArtifact {
    properties: GenesisImmutableProperties
    mutables: GenesisMutableProperties
    balances: [[address: string, amount: string]]
    timestamp: number
    previous_genesis_hash: string
    previous_block_hash: string
    signature: string
    hash: string
    number: number
}

// !SECTION Primitives

// SECTION Components

export interface StandardGenesis {
    properties: GenesisImmutableProperties
    mutables: GenesisMutableProperties
    balances: [[address: string, amount: string]]
    timestamp: number
}

export interface forkGenesis extends StandardGenesis {
    previous_genesis_hash: string
    previous_block_hash: string
}

// !SECTION Components

// INFO The Genesis class with its methods
export default class Genesis {
    genesisBlock: Block //  The genesis block
    genesisStatus: GenesisArtifact // JSON artifact of the final genesis block
    balances: any

    constructor() {}

    // TODO Getters and setters

    // INFO Get and compile all the genesis blocks
    async getGenesisBlock(): Promise<void> {
        this.genesisBlock = await Chain.getGenesisBlock()
    }

    // TODO Replacement of findGenesisBlock.ts

    // INFO Method to sum all the genesis blocks in a final artifact
    async deriveGenesisStatus(): Promise<void> {
        // TODO cycle through all the genesis blocks and sum them up
    }
}
