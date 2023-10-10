/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Mempool from "../mempool"
import Block from "../blocks"
import Transaction from "../transaction"
import sharedState from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import { PeerManager } from "src/libs/peer"

// INFO Using its Mempool, each node can generate the same block having the same content
// NOTE This is tought to be executed after the mempool syncing between nodes
export default async function buildProposedBlock(): Promise<Block> {
    let proposedBlock = new Block()
    let mempool = await Mempool.getMempool()
    const peerManager = PeerManager.getInstance()
    let onlinePeers = await peerManager.getOnlinePeers()
    let txs = mempool.transactions
    let ordered_txs: Transaction[]
    let per_user_txs: Map<string, Transaction[]> = new Map<
        string,
        Transaction[]
    >()
    // NOTE Order transactions by rpc fee (aka divide gas fee in rpc and network)
    mempool = await Mempool.sort(mempool)
    // Iterating through the transactions in the mempool to sort them and exclude invalid ones
    for (let i = 0; i < txs.length; i++) {
        console.log("Processing transaction " + txs[i].hash)
        // If an address has two txs with the same nonce, the richest replaces the other
        mempool = await Mempool.checkNonce(txs[i])
        // We also update the per_user_txs map
        let user = txs[i].content.from.toString("hex")
        per_user_txs[user].push(txs[i]) // REVIEW Does it works on empty lists?
    }
    // REVIEW Setting the block content
    proposedBlock.content.ordered_transactions = ordered_txs
    proposedBlock.content.per_address_transactions = per_user_txs
    // Now we have all the transactions in the mempool, sorted by tx fee and with nonce applied
    // We complete the block
    proposedBlock.proposer = sharedState.getInstance().publicKey
    proposedBlock.timestamp = new Date().getTime()
    proposedBlock.onlinePeers = onlinePeers.map(peer =>
        peer.identity.toString(),
    )
    // Cryptography on the block
    proposedBlock.hash = Hashing.sha256(JSON.stringify(proposedBlock.content))
    if (!proposedBlock.validation_data) {
        proposedBlock.validation_data = {}
    }
    let signed_hash = Cryptography.sign(
        proposedBlock.hash,
        sharedState.getInstance().privateKey,
    )
    proposedBlock.validation_data[
        sharedState.getInstance().publicKey.toString("hex")
    ] = signed_hash
    return proposedBlock
}
