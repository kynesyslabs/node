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
export default function buildProposedBlock(): Block{
    let block = new Block()
    let txs = Mempool.getInstance().transactions
    let ordered_txs: Transaction[]
    let per_user_txs: Map<string, Transaction[]>
    // TODO Do stuff to sort per timestamp and so on
    for (let i = 0; i < txs.length; i++) {
        console.log("Processing transaction " + txs[i].hash)
        // TODO Order transactions by timestamp
        // TODO Order transactions by address
        // TODO If an address has two txs with the same nonce, the second replaces the first
        // TODO In this case (the above one) ordered_txs will be updated to show the replaced status of the tx
    }
    // Setting the block content
    block.content.ordered_transactions = ordered_txs
    block.content.per_address_transactions = per_user_txs
    // TODO Cryptography on the block
    return block
}