import Block from "src/libs/blockchain/block"
import { getSharedState } from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"
import { Transaction } from "@kynesyslabs/demosdk/types"
import Peer from "src/libs/peer/Peer"

export async function createBlock(
    orderedTransactions: Transaction[],
    commonValidatorSeed: string,
    previousBlockHash: string,
    blockNumber: number,
    peerlist: Peer[],
): Promise<Block> {
    if (getSharedState.candidateBlock) {
        log.warning("Candidate block already exists: we should not overwrite it (returning the existing one)")
        // ? Number check?
        return getSharedState.candidateBlock
    }
    // Creating the block
    var block = new Block()
    block.content.ordered_transactions = orderedTransactions.map(transaction => transaction.hash)
    block.content.previousHash = previousBlockHash
    block.content.peerlist = peerlist
    block.proposer = commonValidatorSeed // This is the shard identifier
    block.number = blockNumber
    block.hash = Hashing.sha256(JSON.stringify(block.content))
    // ! Check if we need other fields (probably)
    // Signing the block and adding the signature to the block validation data
    let blockSignature = Cryptography.sign(
        block.hash,
        getSharedState.identity.ed25519.privateKey,
    )
    
    // ? Probably to remove once we have the mechanism working for v2
    if (!block.validation_data) {
        block.validation_data = { signatures: {} }
    }
    
    block.validation_data.signatures[ // ! Define a decent type for validation_data
        getSharedState.identity.ed25519.publicKey.toString("hex")
    ] = blockSignature.toString("hex")
    /* NOTE - The block timestamp is the average timestamp of the shard 
    see averageTimestamp.ts for more details */
    block.content.timestamp = getSharedState.lastConsensusTime
    // Add the candidate to the shared state
    getSharedState.candidateBlock = block
    return block
}