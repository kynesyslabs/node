import Block from "src/libs/blockchain/blocks"
import Hashing from "src/libs/crypto/hashing"
import Mempool from "src/libs/blockchain/mempool"

// INFO This function ingests a proposed Block object and compare it to our proposed Block object.
export default async function validateProposedBlock (proposedBlock: Block): Promise<boolean> {
    let valid = true
    // Calculating our block hash
    let ourBlock = Mempool.getInstance().getProposedBlock()
    // TODO Clearly we can't rely on hashing the blocks as they can have a different order (while having the same transactions)
    let block_hash = Hashing.sha256(JSON.stringify(ourBlock))
    let proposed_block_hash = Hashing.sha256(JSON.stringify(proposedBlock))
    if (block_hash!== proposed_block_hash) {
        valid = false
    }
    return valid
}