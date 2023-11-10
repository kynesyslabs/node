// INFO Module to derive a block from a Mempool data type
import { MempoolData } from "src/libs/blockchain/mempool"
import Chain from "src/libs/blockchain/chain"
import Block from "src/libs/blockchain/blocks"
import sharedState from "src/utilities/sharedState"
import Transaction from "src/libs/blockchain/transaction"
import orderTxs from "./orderTxs"
import Hashing from "src/libs/crypto/hashing"
import assignTxs from "./assignTxs"

export default async function deriveBlock(
    mempoolData: MempoolData,
    timestamp: number,
): Promise<Block> {
    // Deriving an empty block and setting the few properties we can use right now
    let derivedBlock: Block = new Block()
    derivedBlock.status = "derived"
    let proposer = sharedState
        .getInstance()
        .identity.ed25519.publicKey.toString("hex")
    derivedBlock.proposer = proposer
    derivedBlock.content.timestamp = timestamp
    // REVIEW Order transactions
    let ordered_transactions: Transaction[] = await orderTxs(
        mempoolData.transactions,
    )
    derivedBlock.content.ordered_transactions = ordered_transactions
    // REVIEW Derive hashes per address
    let transactions_per_address = await assignTxs(mempoolData.transactions)
    derivedBlock.content.per_address_transactions = transactions_per_address
    // TODO Look for web2data into the mempool
    let web2data = {}
    derivedBlock.content.web2data = web2data
    // Taking the previous hash from the blockchain
    let previousHash = await Chain.getLastBlockHash()
    derivedBlock.hash = Hashing.sha256(JSON.stringify(derivedBlock.content))
    derivedBlock.content.previousHash = previousHash
    return derivedBlock
}
