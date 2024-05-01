import Block from "src/libs/blockchain/block"
import Chain from "src/libs/blockchain/chain"
// INFO Module to derive a block from a Mempool data type
import { MempoolData } from "src/libs/blockchain/mempool"
import Transaction from "src/libs/blockchain/transaction"
import Hashing from "src/libs/crypto/hashing"
import sharedState from "src/utilities/sharedState"

import assignTxs from "./assignTxs"
import orderTxs from "./orderTxs"

export default async function deriveBlock(
    mempoolData: MempoolData,
    timestamp: number,
): Promise<{
    derivedBlock: Block
    full_ordered_transactions: Transaction[]
}> {
    // Deriving an empty block and setting the few properties we can use right now
    let derivedBlock: Block = new Block()
    derivedBlock.status = "derived"
    // We can infer the block number from the last block
    let lastBlockNumber = await Chain.getLastBlockNumber()
    derivedBlock.number = lastBlockNumber + 1
    let proposer = sharedState
        .getInstance()
        .identity.ed25519.publicKey.toString("hex")
    derivedBlock.proposer = proposer
    derivedBlock.content.timestamp = timestamp
    // REVIEW Order transactions
    let full_ordered_transactions: Transaction[] = await orderTxs(
        mempoolData.transactions,
    )

    let ordered_transactions_hashes = full_ordered_transactions.map((tx) => tx.hash)
    derivedBlock.content.ordered_transactions = ordered_transactions_hashes
    // TODO Look for web2data in the mempool
    let web2data = {}
    derivedBlock.content.web2data = web2data
    // Taking the previous hash from the blockchain
    let previousBlock = await Chain.getLastBlock()
    let previousBlockHash = previousBlock.hash
    console.log("Deriving block...")
    derivedBlock.content.previousHash = previousBlockHash
    let sContent = JSON.stringify(derivedBlock.content)
    derivedBlock.hash = Hashing.sha256(sContent)
    //console.log(derivedBlock.content)
    //console.log(sContent)
    // process.exit(0)

    return { derivedBlock, full_ordered_transactions }
}
