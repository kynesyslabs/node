import Transaction from "src/libs/blockchain/transaction"
import getCommonValidatorSeed from "./routines/getCommonValidatorSeed"
import getShard from "./routines/getShard"
import Mempool, { MempoolData } from "src/libs/blockchain/mempool"
import Block from "src/libs/blockchain/block"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import Chain from "src/libs/blockchain/chain"
import sharedState from "src/utilities/sharedState"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"
import { ConsensusHashVote, ConsensusHashResponse, ValidationData } from "./interfaces"
import { mergeMempools } from "./routines/mergeMempools"
import { createBlock } from "./routines/createBlock"
import { orderTransactions } from "./routines/orderTransactions"
import { broadcastBlockHash } from "./routines/broadcastBlockHash"
import averageTimestamps from "./routines/averageTimestamp"

// Wrapper for the consensus routine calling all the necessary subroutines
export async function consensusRoutine() {
    // ! Add a way to average the timestamps of the nodes in the shard to assign a common timestamp to the block
    // ! Add a way to exclude nodes from the shard if they are too far in the past or too far in the future
    // Setting the shared state to consensus mode
    sharedState.getInstance().consensusMode = true
    sharedState.getInstance().inConsensusLoop = true
    sharedState.getInstance().lastTimestamp = Date.now()
    // Deriving our parameters
    const previousBlockHash = await Chain.getLastBlockHash()
    const lastBlockNumber = await Chain.getLastBlockNumber()
    const commonValidatorSeed = await getCommonValidatorSeed() // This should be the same for all nodes
    const shard = await getShard(commonValidatorSeed) // This should be the same for all nodes too
    // NOTE If we are not in the shard, we should wait for a block broadcasted by the shard
    let ourIdentity = sharedState.getInstance().identity.ed25519.publicKey.toString("hex")
    let isInShard = false
    for (const peer of shard) {
        if (peer.identity === ourIdentity) {
            isInShard = true
            break
        }
    }
    if (!isInShard) {
        log.info("[consensusRoutine] We are not in the shard, waiting for the block")
        // ! Should we just go on with the RPC operations and listen for the block? I think so
        // ? We can control once the block arrives if it is created by a node in the shard using the lastShard state
        return
    } else {
        log.info("[consensusRoutine] We are in the shard, creating the block")
    }
    log.info(`[consensusRoutine] shard: ${shard}`)
    // Averaging the timestamps of the nodes in the shard
    const averageTimestamp = await averageTimestamps(shard)
    sharedState.getInstance().lastConsensusTime = averageTimestamp
    // Sending our mempool to the shard while waiting for the others to do the same
    const ourMempool = await Mempool.getMempool() // ? Could this be already modified by time we send it? Do we care?
    log.info("[consensusRoutine] Our mempool has been retrieved")
    const mempool = await mergeMempools(ourMempool, shard)
    log.info("[consensusRoutine] Mempools have been merged")
    // Now the shard should have the same mempool, merged with the mempools of the other nodes
    var orderedTransactions = await orderTransactions(mempool)
    var block = await createBlock(
        orderedTransactions,
        commonValidatorSeed,
        previousBlockHash,
        lastBlockNumber + 1,
    )

    // Broadcasting the block hash to the shard and getting the votes
    log.info(`[consensusRoutine] Broadcasting block hash to the shard: ${block.hash}`)
    const [pro, con] = await broadcastBlockHash(block, shard)
    log.info(`[consensusRoutine] Block hash broadcasted to the shard: ${block.hash}`)
    log.info(`[consensusRoutine] Votes:\nPro: ${pro}\nCon: ${con}`)
    // ? Ensure all the shards have voted somehow? Already done?
    // ? If not, we should do it here
    // Checking if the block is valid with a BFT approach
    const totalVotes = shard.length
    const threshold = Math.floor(totalVotes * 2 / 3) + 1
    log.info(`[consensusRoutine] Threshold: ${threshold}`)
    log.info(`[consensusRoutine] Total votes: ${totalVotes}`)
    log.info(`[consensusRoutine] Block hash: ${block.hash}`)
    if (pro >= threshold) {
        log.info(`[consensusRoutine] Block is valid with ${pro} votes`)
        // Add the block to the chain
        Chain.insertBlock(block)
        sharedState.getInstance().consensusMode = false
        sharedState.getInstance().inConsensusLoop = false
        log.info("[consensusRoutine] Block added to the chain")
        const lastBlock = await Chain.getLastBlock()
        console.log(lastBlock)
        // REVIEW End of the consensus routine
    } else {
        log.info(`[consensusRoutine] Block is not valid with ${pro} votes`)
    }
    // Deleting the candidate block
    sharedState.getInstance().candidateBlock = null
    // NOTE Adding the block to the blockchain is done above
    // Setting the last consensus time in the shared state
    sharedState.getInstance().lastConsensusTime = Date.now()
}
