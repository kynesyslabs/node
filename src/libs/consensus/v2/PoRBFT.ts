import Transaction from "src/libs/blockchain/transaction"
import getCommonValidatorSeed from "./routines/getCommonValidatorSeed"
import getShard from "./routines/getShard"
import Mempool, { MempoolData } from "src/libs/blockchain/mempool"
import Block from "src/libs/blockchain/block"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import Chain from "src/libs/blockchain/chain"
import { getSharedState } from "src/utilities/sharedState"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"
import {
    ConsensusHashVote,
    ConsensusHashResponse,
    ValidationData,
} from "./interfaces"
import { mergeMempools } from "./routines/mergeMempools"
import mergePeerlist from "./routines/mergePeerlist"
import { createBlock, hashNativeTables } from "./routines/createBlock"
import { orderTransactions } from "./routines/orderTransactions"
import { broadcastBlockHash } from "./routines/broadcastBlockHash"
import averageTimestamps from "./routines/averageTimestamp"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import ShardManager, {
    ValidatorStatus,
    getShardManager,
} from "./routines/shardManager"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import applyGCROperation from "src/libs/blockchain/gcr/gcr_routines/applyGCROperation"
import { txToGCROperation } from "src/libs/blockchain/gcr/gcr_routines/txToGCROperation"
import Secretary from "./routines/secretary"

/* INFO

# Semaphore system

 The consensus routine is the main function that runs the consensus algorithm.
 Within the consensus routine there is a semaphore system that ensure the shard
 to have a common state and to avoid race conditions such as node desynchronization.
 
 Each important step of the consensus routine broadcast a message to the shard
 to inform the other nodes that the step has been completed.
 
 All the nodes in the shard (including the local node) will wait for the step to be completed 
 before proceeding to the next step.
 
 This way we ensure that the shard will have a common state and will be able to
 continue the consensus routine.

 For example, the shard manager is initialized at the beginning of the consensus routine
 and the local status is updated to reflect that we are in consensus loop.
 Prior to continue the consensus routine, the local node will wait that also the
 other nodes in the shard are in consensus loop by checking the validator statuses.
    
 The semaphore system is implemented by the ShardManager class.

 # Synchronization of timestamps

 The local node timestamp is calculated from the NTP server pool so that is precise
 and UTC based. 
 
 This happens at each mainLoop cycle, and is the basis to check if the consensus time
 is reached and to compute the average timestamp of the last block.

 This allows to have a precise time synchronization between the nodes in the shard within
 a +/-2 second range.
 
*/

// Main consensus routine calling all the subroutines
export async function consensusRoutine(): Promise<void> {
    if (isConsensusAlreadyRunning()) {
        log.warning(
            "[consensusRoutine] Consensus loop already running: keeping it running (returning)",
            false,
        )
        return
    }

    // Initialize the consensus state and check if the local node is in the shard
    await initializeConsensusState()
    const shard = await initializeShard()

    if (!isInShard(shard)) {
        log.info(
            "[consensusRoutine] We are not in the shard, waiting for the block",
        )
        return
    }

    log.info("[consensusRoutine] We are in the shard, creating the block")
    log.info(`[consensusRoutine] shard: ${shard}`, false)

    // Initialize the shard manager transmitting that we are in consensus loop
    await initializeShardManager(shard)

    // Using the secretary to update the local statuses
    // ? Without waiting for the secretary to update the statuses? Because we are at the beginning of the consensus routine
    await _updateValidatorStatus("inConsensusLoop", true, false, true)
    await _updateValidatorStatus("initializedShardManager", true, false, true)

    // Here we wait that the shard is ready by checking the validators statuses and if they are in consensus loop
    // We can't continue until the shard is ready and synced to our validator status
    // ? Should we use updateValidatorStatus instead of waitUntilShardIsReady directly?
    let shardIsReady = await getShardManager.waitUntilShardIsReady(
        getShardManager.getOurValidatorStatus(),
    )
    // See ShardManager.ts -> waitUntilShardIsReady for the above call
    // TODO Do something with the shardIsReady variable
    log.info("[consensusRoutine] Shard readiness is: " + shardIsReady)

    // synchronize and average the time between the shard and the local node
    await synchronizeAndAverageTime(shard)
    // Merge and order the mempools between the shard and the local node
    const mempool = await mergeAndOrderMempools(shard)

    // REVIEW Merge the peerlist between the shard and the local node
    const peerlist = [] // await mergePeerlistAndWait(shard)

    log.info(
        "[consensusRoutine] mempool merged (aka ordered transactions)",
        true,
    )
    log.info(
        "[consensusRoutine] mempool: " + JSON.stringify(mempool, null, 2),
        true,
    )

    /** REVIEW
     * Here we apply the GCR operations to the state before forging the block
     * so that the GCR hash is included in the block.
     * A list of successful and failed GCR operations is returned.
     * NOTE A mandatory validator status is updated to reflect that the GCR operations have been applied
     * */
    // ! Not here but check Sync.ts (syncNativeTables) and make it work with the GCR (syncing the states)
    await applyGCRForNewBlock(mempool)

    // Forge the block from the ordered transactions
    const block = await forgeBlock(mempool, peerlist) // NOTE The GCR hash is calculated here and added to the block
    // REVIEW Set last consensus time to the current block timestamp
    getSharedState.lastConsensusTime = block.content.timestamp

    // Vote on the block by broadcasting the block hash to the shard
    const [pro, con] = await voteOnBlock(block, shard)

    // Check if the block is valid using BFT
    if (isBlockValid(pro, shard.length)) {
        log.info(
            "[consensusRoutine] [result] Block is valid with " + pro + " votes",
        )
        await finalizeBlock(block, pro)
    } else {
        log.info(
            `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
        )
    }

    // Cleanup the consensus state
    cleanupConsensusState()
    // Destroy the shard manager to free it up for the next consensus routine
    ShardManager.destroy()
    log.info("[consensusRoutine] Consensus routine ended")
}

// Safeguard to prevent multiple consensus loops from running
export function isConsensusAlreadyRunning(): boolean {
    if (getSharedState.inConsensusLoop) {
        log.warning(
            "Consensus loop already running: keeping it running (returning)",
        )
        return true
    }
    return false
}

// Initialize the consensus state
async function initializeConsensusState(): Promise<void> {
    log.info("[consensusRoutine] Starting the consensus routine")
    getSharedState.consensusMode = true
    getSharedState.inConsensusLoop = true
    getSharedState.lastTimestamp = getNetworkTimestamp()
    // Reset the startingConsensus flag
    getSharedState.startingConsensus = false
}

// SECTION Initalizations

async function initializeShard(): Promise<Peer[]> {
    const commonValidatorSeed = await getCommonValidatorSeed()
    return await getShard(commonValidatorSeed)
}
// Initialize the shard manager
async function initializeShardManager(shard: Peer[]): Promise<void> {
    getShardManager.setShard(shard)
    const ourIdentity =
        getSharedState.identity.ed25519.publicKey.toString("hex")
    let validatorStatus = getShardManager.shardStatus.get(ourIdentity)
    validatorStatus.inConsensusLoop = true
    await _updateValidatorStatus("inConsensusLoop", true, false, true)
    getShardManager.setValidatorStatus(ourIdentity, validatorStatus)
    await getShardManager.transmitOurValidatorStatus()
}

// SECTION Checks

// Check if the local node is in the shard
function isInShard(shard: Peer[]): boolean {
    const ourIdentity =
        getSharedState.identity.ed25519.publicKey.toString("hex")
    return shard.some(peer => peer.identity === ourIdentity)
}

// SECTION Routines

// Synchronize and average the time between the shard and the local node
async function synchronizeAndAverageTime(shard: Peer[]): Promise<void> {
    await fastSync(shard)
    var averageTimestamp = await averageTimestamps(shard)
    // Strip the decimal part
    if (!Number.isInteger(averageTimestamp)) {
        log.warning(
            "[synchronizeAndAverageTime] Average timestamp is not an integer",
        )
        averageTimestamp = Math.round(averageTimestamp)
    }
    getSharedState.lastConsensusTime = averageTimestamp
    // Using the secretary to update the local statuses
    await _updateValidatorStatus("synchronizedTime", true, false, true)
}

// Merge the peerlist between the shard and the local node
async function mergePeerlistAndWait(shard: Peer[]): Promise<Peer[]> {
    const mergedPeerList = await mergePeerlist(shard)
    //await updateValidatorStatus("mergedPeerlist", true, false, true)
    // Using the secretary to update the local statuses
    await _updateValidatorStatus("mergedPeerlist", true, false, true)
    return mergedPeerList
}

// Merge and order the mempools between the shard and the local node
async function mergeAndOrderMempools(shard: Peer[]): Promise<Transaction[]> {
    const ourMempool = await Mempool.getMempool()
    console.log("[consensusRoutine] Our mempool:")
    console.log(ourMempool)
    log.info("[consensusRoutine] Our mempool has been retrieved")
    const mergedMempool = await mergeMempools(ourMempool, shard)
    log.info("[consensusRoutine] Mempools have been merged")
    // await updateValidatorStatus("mergedMempool", true, false, true)
    // Using the secretary to update the local statuses
    await _updateValidatorStatus("mergedMempool", true, false, true)
    return await orderTransactions(mergedMempool)
}

// Forge the block from the ordered transactions
async function forgeBlock(
    orderedTransactions: Transaction[],
    peerlist: Peer[] = [],
): Promise<Block> {
    const previousBlockHash = await Chain.getLastBlockHash()
    const lastBlockNumber = await Chain.getLastBlockNumber()
    const commonValidatorSeed = await getCommonValidatorSeed()

    // REVIEW Add the GCR hash to the block should be done in createBlock
    const block = await createBlock(
        orderedTransactions,
        commonValidatorSeed,
        previousBlockHash,
        lastBlockNumber + 1,
        peerlist,
    )

    // await updateValidatorStatus("forgedBlock", true, false, true)
    // Using the secretary to update the local statuses
    await _updateValidatorStatus("forgedBlock", true, false, true)
    return block
}

// Vote on the block by broadcasting the block hash to the shard
async function voteOnBlock(
    block: Block,
    shard: Peer[],
): Promise<[number, number]> {
    log.info(
        `[consensusRoutine] Broadcasting block hash to the shard: ${block.hash}`,
    )
    const [pro, con] = await broadcastBlockHash(block, shard)
    // await updateValidatorStatus("votedForBlock", true, false, true)
    // Using the secretary to update the local statuses
    await _updateValidatorStatus("votedForBlock", true, false, true)

    log.info(
        `[consensusRoutine] Block hash broadcasted to the shard: ${block.hash}`,
    )
    log.info(`[consensusRoutine] Votes:\nPro: ${pro}\nCon: ${con}`)

    return [pro, con]
}

// Check if the block is valid using BFT
function isBlockValid(pro: number, totalVotes: number): boolean {
    const threshold = Math.floor((totalVotes * 2) / 3) + 1
    log.info(`[consensusRoutine] Threshold: ${threshold}`)
    log.info(`[consensusRoutine] Total votes: ${totalVotes}`)
    return pro >= threshold
}

// Finalize the block
async function finalizeBlock(block: Block, pro: number): Promise<void> {
    log.info(`[consensusRoutine] Block is valid with ${pro} votes`)
    console.log(block)
    await Chain.insertBlock(block) // NOTE Transactions are added to the Transactions table here
    //getSharedState.consensusMode = false
    ///getSharedState.inConsensusLoop = false
    log.info("[consensusRoutine] Block added to the chain")
    const lastBlock = await Chain.getLastBlock()
    console.log(lastBlock)
}

// REVIEW Apply the GCR operations to the state
async function applyGCRForNewBlock(
    mempool: Transaction[],
): Promise<[string[], string[]]> {
    let successfulTxs: string[] = []
    let failedTxs: string[] = []
    for (const tx of mempool) {
        const operation = await txToGCROperation(tx)
        let success = await applyGCROperation(operation)
        if (success) {
            successfulTxs.push(tx.hash)
        } else {
            failedTxs.push(tx.hash)
        }
    }
    log.info(`[consensusRoutine] Successful GCR operations: ${successfulTxs}`)
    log.info(`[consensusRoutine] Failed GCR operations: ${failedTxs}`)
    // await updateValidatorStatus("appliedGCR", true, false, true)
    // Using the secretary to update the local statuses
    await _updateValidatorStatus("appliedGCR", true, false, true)
    return [successfulTxs, failedTxs]
}

// SECTION New secretary system

/** TODO
 * - Check if the wait logic in updateValidatorStatus is working as expected
 * - Replace the current updateValidatorStatus method with the new one (_updateValidatorStatus)
 * - Implement the get logic too when is needed
 * - Implement fallback to the second secretary when the first one is not available
 * ? Moving the secretary logic to a new class or unifying it with the current one?
 */

// REVIEW This method and the below one will be used to get the status of a node or the whole shard
async function getValidatorStatus(peerKey: string): Promise<ValidatorStatus> {
    const secretary: Peer = getShardManager.getShard()[0]
    let status: ValidatorStatus
    let syncedTimestamp: number
    if (
        secretary.identity ==
        getSharedState.identity.ed25519.publicKey.toString("hex")
    ) {
        log.info(
            `[getValidatorStatus] Getting the status of the node: ${peerKey} from ourselves as we are the secretary`,
        )
        status = Secretary.getInstance().getStatus(peerKey)
        syncedTimestamp = getSharedState.currentTimestamp
    } else {
        log.info(
            `[getValidatorStatus] Getting the status of the node: ${peerKey} from the secretary (${secretary.identity})`,
        )
        let jsonCall: RPCRequest = {
            method: "consensus_routine",
            params: [
                {
                    method: "getSecretaryStatus",
                    params: [peerKey],
                },
            ],
        }
        let response = await secretary.call(jsonCall)
        status = response.response as ValidatorStatus
        syncedTimestamp = response.extra
    }
    log.info(`[getValidatorStatus] Status of the node: ${peerKey} retrieved`)
    // Setting the local status for the peer to the one in the response
    Secretary.getInstance().setStatus(peerKey, status)
    // Setting the current timestamp to the one in the response
    log.info(
        `[getValidatorStatus] Setting the current timestamp to the one in the response: ${syncedTimestamp}`,
    )
    getSharedState.currentTimestamp = syncedTimestamp
    return status
}

async function getShardStatus(): Promise<Map<string, ValidatorStatus>> {
    const secretary: Peer = getShardManager.getShard()[0]
    let statusMap: Map<string, ValidatorStatus>
    let syncedTimestamp: number
    if (
        secretary.identity ==
        getSharedState.identity.ed25519.publicKey.toString("hex")
    ) {
        log.info(
            "[getShardStatus] Getting the status of the whole shard from ourselves as we are the secretary",
        )

        statusMap = Secretary.getInstance().getAllStatus()
        syncedTimestamp = getSharedState.currentTimestamp
    } else {
        log.info(
            `[getShardStatus] Getting the status of the whole shard from the secretary (${secretary.identity})`,
        )
        let jsonCall: RPCRequest = {
            method: "consensus_routine",
            params: [
                {
                    method: "getSecretaryStatus",
                    params: [],
                },
            ],
        }
        let response = await secretary.call(jsonCall)
        statusMap = new Map(Object.entries(response.response)) as Map<
            string,
            ValidatorStatus
        >
        syncedTimestamp = response.extra
    }
    log.info("[getShardStatus] Status of the whole shard retrieved")
    // Updating the local statuses from the secretary response
    Secretary.getInstance().setAllStatus(statusMap)
    log.info(
        "[getShardStatus] All statuses updated locally from the secretary response",
    )
    // Setting the current timestamp to the one in the response
    log.info(
        `[getShardStatus] Setting the current timestamp to the one in the response: ${syncedTimestamp}`,
    )
    getSharedState.currentTimestamp = syncedTimestamp
    return statusMap
}

// REVIEW Authenticated method calling the secretary endpoint to update the last seen time
async function updateLastSeen(secretary: Peer): Promise<RPCResponse> {
    const bufferSignature = await Cryptography.sign(
        getSharedState.identity.ed25519.publicKey.toString("hex"),
        getSharedState.identity.ed25519.privateKey,
    )
    const signature = bufferSignature.toString("hex")
    var baseCall: RPCRequest = {
        method: "consensus_routine",
        params: [
            {
                method: "updateLastSeen",
                params: [
                    getSharedState.identity.ed25519.publicKey.toString("hex"),
                    signature,
                ],
            },
        ],
    }
    const response = await secretary.call(baseCall)
    if (response.result !== 200) {
        log.warning(
            `[updateLastSeen] Failed to update the last seen time: ${response.response}`,
        )
    }
    return response
}

// REVIEW Authenticated method calling the secretary endpoint to set the wait status
async function setWaitStatus(
    secretary: Peer,
    waitStatus: boolean,
): Promise<RPCResponse> {
    const bufferSignature = await Cryptography.sign(
        getSharedState.identity.ed25519.publicKey.toString("hex"),
        getSharedState.identity.ed25519.privateKey,
    )
    const signature = bufferSignature.toString("hex")
    var baseCall: RPCRequest = {
        method: "consensus_routine",
        params: [
            {
                method: "setWaitStatus",
                params: [
                    getSharedState.identity.ed25519.publicKey.toString("hex"),
                    waitStatus,
                    signature,
                ],
            },
        ],
    }
    const response = await secretary.call(baseCall)
    if (response.result !== 200) {
        log.warning(
            `[setWaitStatus] Failed to set the wait status: ${response.response}`,
        )
    }
    return response
}

// This method updates the validator status and waits for the shard to be ready
// NOTE It contains the logic to update the last seen time and set the wait status too
async function _updateValidatorStatus(
    status: string,
    wait: boolean = true,
    // Below args are just for compatibility with the current updateValidatorStatus method
    pull: boolean = false,
    stream: boolean = true,
    updateLastSeenFlag: boolean = true,
): Promise<boolean> {
    // Inferring the shard secretary
    const secretary: Peer = getShardManager.getShard()[0]
    // Getting the current status of the local node and updating it
    var currentStatus = getShardManager.getOurValidatorStatus()
    currentStatus[status] = true // NOTE We are using this to update the status locally and then transmit it to the secretary
    getShardManager.setValidatorStatus(
        getSharedState.identity.ed25519.publicKey.toString("hex"),
        currentStatus,
    ) // Here we ensure that the status is updated in the singleton too so we can use it to check if the shard is ready
    // Checking if the secretary is the local node
    if (
        secretary.identity ===
        getSharedState.identity.ed25519.publicKey.toString("hex")
    ) {
        log.info("[updateValidatorStatus] Updating the status locally", true)
        // Updating the status locally
        Secretary.getInstance().setStatus(
            getSharedState.identity.ed25519.publicKey.toString("hex"),
            currentStatus,
        )
    } else {
        log.info(
            "[updateValidatorStatus] Sending the status update to the secretary",
            true,
        )
        // Sending the status update to the secretary
        var jsonCall: RPCRequest = {
            method: "consensus_routine",
            params: [
                {
                    method: "setSecretaryStatus",
                    params: [
                        getSharedState.identity.ed25519.publicKey.toString(
                            "hex",
                        ),
                        currentStatus,
                    ],
                },
            ],
        }
        const response = await secretary.call(jsonCall)
        if (response.result !== 200) {
            log.warning(
                `[updateValidatorStatus] [ERROR] Failed to set the secretary status: ${response.response}`,
            )
            return false
        } else {
            log.info(
                `[updateValidatorStatus] Secretary held status is: ${response.response}`,
            )
            // Updating the local statuses from the secretary response
            const statusMap = new Map(Object.entries(response.response)) as Map<
                string,
                ValidatorStatus
            >
            Secretary.getInstance().setAllStatus(statusMap)
            log.info(
                "[updateValidatorStatus] All statuses updated locally from the secretary response",
            )
            // Handle the response and update the local timestamp with the secretary's timestamp
            getSharedState.currentTimestamp = response.extra
        }
    }
    log.info("[updateValidatorStatus] Status updated")
    // REVIEW Update last seen logic
    if (updateLastSeenFlag) {
        await updateLastSeen(secretary)
    }
    // Wait logic
    // ! Move this to a new method + rewrite the logic using the new secretary methods (setWaitStatus, updateLastSeen and related)
    if (wait) {
        // REVIEW Setting the wait status
        await setWaitStatus(secretary, true)
        // Waiting for the shard to be ready
        console.log(
            "[updateValidatorStatus] Waiting for the shard to be ready...",
        )
        let timeout = 3000
        let startTime = Date.now()
        let curTime = startTime
        let shardStatus = await getShardStatus()
        let ourStatus = getShardManager.getOurValidatorStatus()
        let all_synced = false
        while (!all_synced) {
            all_synced = true
            // Updating the current shard status and our status
            shardStatus = await getShardStatus()
            ourStatus = getShardManager.getOurValidatorStatus()
            curTime = Date.now()
            if (curTime - startTime > timeout) {
                log.warning(
                    "[updateValidatorStatus] [ERROR] Shard is not ready: " +
                        status,
                )
                return false
            }
            // Checking each status in the shard to see if it is the same as our status
            for (const status of shardStatus.values()) {
                let theirStatusHash = Hashing.sha256(JSON.stringify(status))
                console.log("theirStatusHash: " + theirStatusHash)
                let ourStatusHash = Hashing.sha256(JSON.stringify(ourStatus))
                console.log("ourStatusHash: " + ourStatusHash)
                if (theirStatusHash !== ourStatusHash) {
                    all_synced = false
                    log.info(
                        "[updateValidatorStatus] [WAIT] Statuses are not synced (specifically our status is not equal to a status in the shard, us:",
                        true,
                    )
                    log.info(JSON.stringify(ourStatus, null, 2))
                    log.info("[updateValidatorStatus] [WAIT] Theirs:")
                    log.info(JSON.stringify(status, null, 2))

                    // Waiting 500ms before trying again
                    await new Promise(resolve => setTimeout(resolve, 500))

                    // REVIEW Update last seen logic
                    await updateLastSeen(secretary)

                    break
                }
            }
        }

        // REVIEW End the wait logic
        await setWaitStatus(secretary, false)
    }
    return true
}

// TODO Wait logic using the new secretary methods
async function waitUntilShardIsReady(): Promise<void> {
    // TODO Implement this
}

// SECTION Old updateValidatorStatus method and related functions

// Cleanup the consensus state
function cleanupConsensusState(): void {
    getSharedState.candidateBlock = null
    getSharedState.lastConsensusTime = getSharedState.currentUTCTime // REVIEW Using the current UTC time as the last consensus time
    getSharedState.inConsensusLoop = false
    getSharedState.consensusMode = false
}

/* TODO Remove this if we are not using it anymore  
// REVIEW This function updates and transmits the validator status to the shard
// NOTE If wait is true, the function will try to wait for the shard to be ready
// before returning with a timeout to prevent the consensus routine from getting stuck
// NOTE If pull is true, the function will try to pull the status from each node
// in the shard before returning to ensure the status is up to date
async function updateValidatorStatus(
    status: string,
    wait: boolean = true,
    pull: boolean = false,
    stream: boolean = true,
): Promise<boolean> {
    const ourIdentity =
        getSharedState.identity.ed25519.publicKey.toString("hex")
    let validatorStatus = getShardManager.shardStatus.get(ourIdentity)
    validatorStatus[status] = true
    getShardManager.setValidatorStatus(ourIdentity, validatorStatus)
    if (stream) {
        await getShardManager.transmitOurValidatorStatus()
    }
    // If not specified otherwise, we wait for the shard to be ready
    let ourStatus = getShardManager.getOurValidatorStatus()
    if (wait) {
        let shardIsReady = await getShardManager.waitUntilShardIsReady(
            ourStatus,
            3000,
            pull,
        )
        if (!shardIsReady) {
            log.warning(
                "[updateValidatorStatus] [ERROR] Shard is not ready: " + status,
            )
            return false
        }
        return true
    }
    return true
}
*/
