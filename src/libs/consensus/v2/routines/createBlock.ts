import Block from "src/libs/blockchain/block"
import sharedState from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"

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
    block.validation_data.signatures[ // ! Define a decent type for validation_data
        sharedState.getInstance().identity.ed25519.publicKey.toString("hex")
    ] = blockSignature.toString("hex")
    return block
}