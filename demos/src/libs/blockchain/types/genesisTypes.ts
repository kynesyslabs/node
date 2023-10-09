// INFO Defining the structure of a valid Genesis block
import Chain from "../chain"

/* INFO
 *
 * Genesis block logic
 *
 * To ensure flexibility and future-proofing, the genesis block is not just an initial hardcoded block, but is
 * also a set of specifications stacking together to create a Genesis status of the chain.
 * This way, is easy for the Blockchain to democratically evolve, and for the community to decide the future of the
 * chain itself by issuing a new Genesis block.
 *
 * Of course, the first Genesis block contains different types of data:
 * - Immutable properties: These are the properties that cannot be changed by the community, and are hardcoded
 *  in the genesis block.
 * - Mutable properties: These are the properties that can be changed by the community, and are specified for
 * every genesis block. They can be changed, overwritten, deleted, ignored or restored.
 * - Balances: These are the minted balances of the Genesis block. They are only specified in the first Genesis
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
    genesisBlocks: StandardGenesis[] // Hashes of the genesis blocks
    genesisStatus: GenesisArtifact // JSON artifact of the final genesis block
    balances: any

    constructor() {}

    // TODO Getters and setters

    // INFO Get and compile all the genesis blocks
    async getGenesisBlocks(): Promise<void> {
        this.genesisBlocks = await Chain.getGenesisBlocks()
    }

    // TODO Replacement of findGenesisBlock.ts

    // INFO Method to sum all the genesis blocks in a final artifact
    async deriveGenesisStatus(): Promise<void> {
        // TODO cycle through all the genesis blocks and sum them up
    }
}
