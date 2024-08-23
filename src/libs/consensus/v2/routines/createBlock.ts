import Block from "src/libs/blockchain/block"
import sharedState from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import Chain from "src/libs/blockchain/chain"

export async function createBlock(
    orderedTransactions: string[],
    commonValidatorSeed: string,
    previousBlockHash: string,
    blockNumber: number,
): Promise<Block> {
    // Creating the block
    var block = new Block()
    block.content.ordered_transactions = orderedTransactions
    block.content.previousHash = previousBlockHash
    block.proposer = commonValidatorSeed // This is the shard identifier
    block.number = blockNumber
    block.hash = Hashing.sha256(JSON.stringify(block.content))
    // ! Check if we need other fields (probably)
    // Signing the block and adding the signature to the block validation data
    let blockSignature = Cryptography.sign(
        block.hash,
        sharedState.getInstance().identity.ed25519.privateKey,
    )
    
    // ? Probably to remove once we have the mechanism working for v2
    if (!block.validation_data) {
        block.validation_data = { signatures: {} }
    }
    
    block.validation_data.signatures[ // ! Define a decent type for validation_data
        sharedState.getInstance().identity.ed25519.publicKey.toString("hex")
    ] = blockSignature.toString("hex")
    /* NOTE - To be sure the timestamp is valid, even if synthetic, we take the genesis block timestamp and
    add (consensusTime*blockNumber) to it. This is to ensure that the timestamp is always increasing and that
    consensus time can be calculated globally.
    */
    let consensusTime = sharedState.getInstance().getConsensusTime() || 10000
    let genesisBlockTimestamp = (await Chain.getGenesisBlock()).content.timestamp
    block.content.timestamp = genesisBlockTimestamp + (consensusTime * blockNumber)
    // Add the candidate to the shared state
    sharedState.getInstance().candidateBlock = block
    return block
}