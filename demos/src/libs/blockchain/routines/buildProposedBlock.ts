/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Mempool from "../mempool"
import Block from "../blocks"
import Transaction from "../transaction"

// INFO Using its Mempool, each node can generate the same block having the same content
export default async function buildProposedBlock(): Promise<Block>{
    let block = new Block()
    let mempool = await Mempool.getMempool()
    let txs = mempool.transactions
    let ordered_txs: Transaction[]
    let per_user_txs: Map<string, Transaction[]>
    // NOTE Order transactions by rpc fee (aka divide gas fee in rpc and network)
    mempool = await Mempool.sort(mempool)
    // Iterating through the transactions in the mempool to sort them and exclude invalid ones
    for (let i = 0; i < txs.length; i++) {
        console.log("Processing transaction " + txs[i].hash)
        // If an address has two txs with the same nonce, the richest replaces the other
        mempool = await Mempool.checkNonce(txs[i])
    }
    // REVIEW Setting the block content
    block.content.ordered_transactions = ordered_txs
    block.content.per_address_transactions = per_user_txs
    // Now we have all the transactions in the mempool, sorted by tx fee and with nonce applied
    // TODO Cryptography on the block
    return block
}