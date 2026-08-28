/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Conflict handling between peers (longest chain)
import { Mutex } from "async-mutex"
import { getSharedState } from "src/utilities/sharedState"
import { isForkActive } from "@/forks"
import Peer from "../../peer/Peer"
import PeerManager from "../../peer/PeerManager"
import Block from "../block"
import Chain from "../chain"
import log from "src/utilities/logger"
import { verifyBlock } from "../validation/verifyBlock"
import { recordSyncedBlock } from "src/libs/consensus/v2/routines/stallDetection"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import {
    BlockInvalidError,
    BlockNotFoundError,
    PeerUnreachableError,
    TimeoutError,
    handleError,
} from "@/errors"
import HandleGCR from "../gcr/handleGCR"
import {
    discoverL2PSParticipants,
    syncL2PSWithPeer,
    exchangeL2PSParticipation,
} from "@/libs/l2ps/L2PSConcurrentSync"
import { BroadcastManager } from "@/libs/communications/broadcastManager"
import { Waiter } from "@/utilities/waiter"
import Mempool from "../mempool"
import Datasource from "@/model/datasource"
import { GCRAssignedTx } from "@/model/entities/GCRv2/GCRAssignedTx"
import { getLastBlockSigners } from "../chainBlocks"
import { TRANSACTION_STATUS } from "@/utilities/constants"
import { orderDeterministically } from "@/libs/consensus/v2/routines/deterministicOrder"
import Hashing from "@/libs/crypto/hashing"
import {
    assertSyncedNonceTrace,
    debugAssertionsEnabled,
    readNonceTrace,
    readNonces,
} from "@/libs/debug/nonceTrace"

/**
 * Used to prevent block insert operations from happening concurrently.
 *
 * 1. Via fastSync routine
 * 2. Via the new block broadcast routine
 */
export const syncLock = new Mutex()

class SyncAssertionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SyncAssertionError"
    }
}

class ForkedPeerError extends Error {
    constructor(
        message: string,
        public readonly validSource: Peer | null,
    ) {
        super(message)
        this.name = "ForkedPeerError"
    }
}

const peerManager = PeerManager.getInstance()
async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

const latestBlock = () =>
    peerManager
        .getAll()
        .reduce((max, peer) => Math.max(max, peer.sync.block), 0)

const highestBlockPeer = () =>
    peerManager.getAll().find(peer => peer.sync.block === latestBlock())

const FAST_SYNC_TIMEOUT_MS = 30_000

/**
 * Per-peer bound for fork-recovery polling. `Peer.call` has no timeout option,
 * so without this one unresponsive candidate would hold the whole
 * `Promise.allSettled` — and the sync round behind it — open indefinitely.
 */
const FORK_POLL_TIMEOUT_MS = 10_000

/**
 * @deprecated
 * Get the highest block number and peer from the network. If we're synced
 * we return null for the peer.
 *
 * @param peers - If specified, we only get the data from these peers.
 */
async function getHigestBlockPeerData(peers: Peer[] = []) {
    // Getting all the peers if not specified
    if (peers.length === 0) {
        peers = peerManager.getPeers()
    }

    if (latestBlock() === getSharedState.lastBlockNumber) {
        return {}
    }

    // Getting our data
    log.debug("[fastSync] Getting our last block number and hash")
    const lastBlock = await Chain.getLastBlock()
    const ourLastBlockNumber = lastBlock.number
    const ourLastBlockHash = lastBlock.hash

    log.info(
        `[fastSync] Our last block number is ${ourLastBlockNumber} and our last block hash is ${ourLastBlockHash}`,
    )

    // REVIEW: With the peer gossip working, can we replace getLastBlockNumber
    // calls with checks on the peerlist?
    // HOW ACCURATE WILL THAT BE? How much accuracy is needed?

    // SECTION: Reading block number from the peerlist
    const blockNumbers = peers.reduce((acc, peer) => {
        acc.push({
            peer: peer.identity,
            block: peer.sync.block,
        })
        return acc
    }, [])

    log.custom(
        "fastsync_blocknumbers",
        "Peerlist block numbers: " + JSON.stringify(blockNumbers),
    )

    // SECTION: Asking the peers for the last block number
    // Asking the peers for the last block number
    const peerLastBlockNumbers = []
    const promises = new Map<string, Promise<RPCResponse>>()
    for (const peer of peers) {
        const call: RPCRequest = {
            method: "nodeCall",
            params: [
                {
                    message: "getLastBlockNumber",
                    data: null,
                    muid: null,
                },
            ],
        }
        promises.set(peer.identity, peer.call(call, false))
    }

    // REVIEW: Phase 3c-3 - Discover L2PS participants concurrently with block discovery
    // Run L2PS discovery in background (non-blocking, doesn't await)
    if (getSharedState.l2psJoinedUids?.length > 0) {
        discoverL2PSParticipants(peers, getSharedState.l2psJoinedUids)
            .then(participantMap => {
                let totalParticipants = 0
                for (const participants of participantMap.values()) {
                    totalParticipants += participants.length
                }
                log.debug(
                    `[Sync] Discovered L2PS participants: ${participantMap.size} networks, ${totalParticipants} total peers`,
                )
            })
            .catch(error => {
                log.error(
                    "[Sync] L2PS participant discovery failed:",
                    error.message,
                )
            })
    }

    // Wait for all the promises to resolve (synchronously?)
    const responses = new Map<string, RPCResponse>()
    for (const [peerId, promise] of promises) {
        const response = await promise
        responses.set(peerId, response)
    }

    const requestBlockNumbers = []

    for (const response of responses) {
        if (response[1].result === 200) {
            peerLastBlockNumbers.push(response[1].response as number)
            log.info(
                "[fastSync] Peer " +
                    response[0] +
                    " has last block number: " +
                    response[1].response,
            )
            // INFO: Log request block number for insights!
            requestBlockNumbers.push({
                peer: response[0],
                block: response[1].response,
            })
        } else {
            peerLastBlockNumbers.push(0)
        }
    }
    log.info(`[fastSync] Peer last block numbers: ${peerLastBlockNumbers}`)
    log.custom(
        "fastsync_blocknumbers",
        "Request block numbers: " + JSON.stringify(requestBlockNumbers),
    )

    // REVIEW Choose the peer with the highest last block number
    const highestBlockNumber: number = peerLastBlockNumbers.reduce(
        (max, peer) => Math.max(max, peer),
        0,
    )

    // If we have the same block number as the highest block number peer, we are already synced
    if (highestBlockNumber === ourLastBlockNumber) {
        log.info("[fastSync] We are already synced")
        // getSharedState.syncStatus = true

        return {
            highestBlockNumber,
            highestBlockNumberPeer: null,
            ourLastBlockNumber,
            ourLastBlockHash,
        }
    }

    // Otherwise, we need to sync
    const highestBlockNumberPeerIndex = peerLastBlockNumbers.findIndex(
        peer => peer === highestBlockNumber,
    )
    const highestBlockNumberPeer = peers[highestBlockNumberPeerIndex]
    log.info(
        "[fastSync] Peer with highest last block number: " +
            highestBlockNumberPeer.identity +
            " with block number: " +
            highestBlockNumber,
    )

    return {
        highestBlockNumber,
        highestBlockNumberPeer,
        ourLastBlockNumber,
        ourLastBlockHash,
    }
}

/**
 * Get a block from a peer
 *
 * @param peer - The peer to get the block from
 * @param blockNumber - The block number to get
 *
 * @returns The block if found, null otherwise
 */
async function getRemoteBlock(peer: Peer, blockNumber: number) {
    const blockRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockByNumber",
                data: { blockNumber: blockNumber.toString() },
            },
        ],
    }

    const blockResponse = await peer.longCall(blockRequest, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    if (blockResponse.result === 200) {
        return blockResponse.response as Block
    }

    return null
}

/**
 * Verify if our last block is coherent with the same block from the peer.
 *
 * @param peer - The peer to cross-check with
 * @param ourLastBlockNumber - Our last block number
 * @param ourLastBlockHash - Our last block hash
 * @returns True if the last block hash is coherent, false otherwise
 */
async function verifyLastBlockIntegrity(
    peer: Peer,
    ourLastBlockNumber: number,
    ourLastBlockHash: string,
): Promise<boolean> {
    const ourGenesisHash = await Chain.getGenesisBlockHash()
    const seenPeers = new Set<string>()
    let currentPeer: Peer | null = peer

    while (currentPeer) {
        seenPeers.add(currentPeer.identity)

        // INFO: Verify genesis hash matches our genesis hash
        const genesisBlock = await getRemoteBlock(currentPeer, 0)

        if (!genesisBlock) {
            log.error(
                `[fastSync] Could not get genesis block from peer ${currentPeer.identity}, trying next peer`,
            )
            currentPeer = findNextAvailablePeer(seenPeers)
            continue
        }

        if (genesisBlock.hash !== ourGenesisHash) {
            log.error(
                `[fastSync] Genesis hash mismatch with peer ${currentPeer.identity}: ours=${ourGenesisHash} peer=${genesisBlock.hash}, trying next peer`,
            )
            currentPeer = findNextAvailablePeer(seenPeers)
            continue
        }

        // Verify if the last block hash is coherent
        const lastSyncedBlock = await getRemoteBlock(
            currentPeer,
            ourLastBlockNumber,
        )

        if (!lastSyncedBlock) {
            log.error(
                `[fastSync] Could not get last block from peer ${currentPeer.identity}, trying next peer`,
            )
            currentPeer = findNextAvailablePeer(seenPeers)
            continue
        }

        return lastSyncedBlock.hash === ourLastBlockHash
    }

    log.error(
        "[fastSync] Exhausted all peers, could not verify last block integrity",
    )
    return false
}

async function verifyBlockAttrs(block: Block, txs: Transaction[]) {
    // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):

    if (txs.length < block.content.ordered_transactions.length) {
        log.error(
            "[fastSync] No transactions received for block: " + block.hash,
        )
        log.debug("Trying to get transaction from signers")

        const masterSet = new Set(block.content.ordered_transactions)
        const missingTxs = masterSet.difference(new Set(txs.map(tx => tx.hash)))

        // get signers for block
        const signers = Object.keys(block.validation_data?.signatures || {})
        for (const signer of signers) {
            const peer = peerManager.getPeer(signer)

            if (!peer) continue

            const res = await askTxsForBlock(block, peer)

            for (const tx of res) {
                if (missingTxs.has(tx.hash)) {
                    txs.push(tx)
                    missingTxs.delete(tx.hash)
                }
            }

            if (missingTxs.size === 0) break
        }

        if (missingTxs.size > 0) {
            log.error(
                `[fastSync] Still missing ${missingTxs.size} transactions even after asking from signers`,
            )
            log.error(
                "Missing transactions: " +
                    JSON.stringify(Array.from(missingTxs), null, 2),
            )
            if (debugAssertionsEnabled()) {
                process.exit(1)
            }
            throw new SyncAssertionError(
                `[fastSync] Still missing ${missingTxs.size} transactions after asking signers for block ${block.number}`,
            )
        }
    }

    for (const tx of txs) {
        if (tx.blockNumber !== block.number) {
            log.error(
                "Transaction block number mismatch: " +
                    tx.hash +
                    ", expected: " +
                    block.number +
                    ", got: " +
                    tx.blockNumber,
            )
            if (debugAssertionsEnabled()) {
                process.exit(1)
            }
            throw new SyncAssertionError(
                "Transaction block number mismatch for " + tx.hash,
            )
        }
    }

    const sorted = orderDeterministically(txs)

    // confirm sorted txs are in the same order as block ordered transactions
    const inputHash = Hashing.sha256(
        JSON.stringify(block.content.ordered_transactions),
    )
    const sortedHash = Hashing.sha256(JSON.stringify(sorted.map(tx => tx.hash)))
    if (inputHash !== sortedHash) {
        log.error(
            "Deterministic order does not match block ordered transactions",
        )
        log.error(
            "Block ordered transactions: " +
                JSON.stringify(block.content.ordered_transactions, null, 2),
        )
        log.error(
            "Sorted transactions: " +
                JSON.stringify(
                    sorted.map(tx => tx.hash),
                    null,
                    2,
                ),
        )
        if (debugAssertionsEnabled()) {
            process.exit(1)
        }
        throw new SyncAssertionError(
            "Deterministic order does not match block ordered transactions for block " +
                block.number,
        )
    }

    const applied = sorted.filter(
        tx => tx.status === TRANSACTION_STATUS.CONFIRMED,
    )

    if (block.attrs == null) {
        return applied
    }

    if (block.attrs["gcrAppliedTxCount"] !== applied.length) {
        log.error(
            "[fastSync] Block attrs gcrAppliedTxCount mismatch: " +
                applied.length +
                ", expected: " +
                block.attrs["gcrAppliedTxCount"],
        )

        if (block.attrs["gcrAppliedTxCount"] > applied.length) {
            // find the missing txs in the original txs list and log them
            const appliedTxSet = new Set(block.attrs["gcrAppliedTxs"])
            const confirmedAppliedTxSet = new Set(applied.map(tx => tx.hash))

            const diff = appliedTxSet.difference(confirmedAppliedTxSet)

            for (const tx of diff) {
                const resolved = sorted.find(t => t.hash === tx)
                if (resolved) {
                    log.error(
                        "[fastSync] Applied by forger, but not US: " +
                            resolved.hash,
                    )
                    log.error(
                        "[fastSync] Transaction full: " +
                            JSON.stringify(resolved, null, 2),
                    )
                } else {
                    log.error(
                        "[fastSync] Missing tx from original txs list: " + tx,
                    )
                }
            }
        }

        if (debugAssertionsEnabled()) {
            process.exit(1)
        }
        throw new SyncAssertionError(
            "[fastSync] Block attrs gcrAppliedTxCount mismatch for block " +
                block.number,
        )
    }

    if (
        block.attrs["gcrAppliedTxsHash"] !==
        Hashing.sha256(JSON.stringify(applied.map(tx => tx.hash)))
    ) {
        log.error(
            "[fastSync] Block attrs gcrAppliedTxsHash mismatch: " +
                block.attrs["gcrAppliedTxsHash"] +
                ", expected: " +
                Hashing.sha256(JSON.stringify(applied.map(tx => tx.hash))),
        )
        log.error(
            "Resolved applied txs: " +
                JSON.stringify(
                    applied.map(tx => tx.hash),
                    null,
                    2,
                ),
        )
        log.error(
            "Fetched Applied txs: " +
                JSON.stringify(block.attrs["gcrAppliedTxs"], null, 2),
        )
        log.error("Full applied txs: " + JSON.stringify(applied, null, 2))
        // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
        if (debugAssertionsEnabled()) {
            process.exit(1)
        }
        throw new SyncAssertionError(
            "[fastSync] Block attrs gcrAppliedTxsHash mismatch for block " +
                block.number,
        )
    }

    return applied
}

/**
 * Given a block and a peer, saves the block into the database, downloads the transactions
 * from the peer and updates the GCR and transaction tables.
 *
 * @param block The block to sync
 * @param peer The peer that sent the block
 * @returns True if the block was synced successfully, false otherwise
 */
export async function syncBlock(block: Block, peer: Peer) {
    let exists = await Chain.getBlockByNumber(block.number)
    if (exists) {
        log.debug("Block already exists, skipping ...")
        return true
    }

    if (isForkActive("nonceEnforcement", getSharedState.lastBlockNumber ?? 0)) {
        const verdict = await verifyBlock(block as never)
        if (!verdict.valid) {
            log.error(
                `[syncBlock] Rejecting synced block ${block.number} (${block.hash}): ${verdict.reason}`,
            )
            return false
        }
        log.info(
            `[syncBlock] Block ${block.number} passed signature-quorum verification`,
        )
    }

    // check exists again
    exists = await Chain.getBlockByNumber(block.number)
    if (exists) {
        log.error("Block already exists, skipping ...")
        return false
    }

    // REVIEW Merge the peerlist
    log.info(`[fastSync] Merging peers from block: ${block.hash}`)
    const mergedPeerlist = await mergePeerlist(block)
    log.info(`[fastSync] Merged peers from block: ${mergedPeerlist}`)
    // REVIEW Parse the txs hashes in the block
    log.info("[fastSync] Asking for transactions in the block", true)
    const txs = await askTxsForBlock(block, peer)
    log.info(`[fastSync] Transactions received: ${txs.length}`, true)

    await assertNoUnreconciledGcrState()

    const applied = await verifyBlockAttrs(block, txs)

    // ! Sync the native tables
    await syncGCRTables(applied, block)

    await insertBlockOrHalt(block, txs)
    log.debug("Block inserted successfully")
    log.debug(
        `Last block number: ${getSharedState.lastBlockNumber} Last block hash: ${getSharedState.lastBlockHash}`,
    )
    log.info("[fastSync] Block inserted successfully at the head of the chain!")

    if (txs.length > 0) {
        if (debugAssertionsEnabled()) {
            // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
            // confirm all txs are inserted
            for (const tx of txs) {
                const res = await Chain.checkTxExists(tx.hash)
                if (!res) {
                    log.error(
                        "[syncGCRTables] Transaction not found: " + tx.hash,
                    )
                    process.exit(1)
                }
            }
            log.debug("[syncGCRTables] All transactions are inserted")
        }
        return true
    }

    log.info("[fastSync] No transactions in the block")
    return true
}

// /**
//  *
//  * @param peer The peer to download the block from
//  * @param blockToAsk The block number to download
//  * @returns The block if downloaded successfully, false otherwise
//  */
// async function downloadBlock(peer: Peer, blockToAsk: number) {
//     const blockRequest: RPCRequest = {
//         method: "nodeCall",
//         params: [
//             {
//                 message: "getBlockByNumber",
//                 data: { blockNumber: blockToAsk.toString() },
//                 muid: null,
//             },
//         ],
//     }

//     const blockResponse = await peer.longCall(blockRequest, true, {
//         protocol: "http",
//         sleepTime: 1000,
//         retries: 3,
//     })
//     log.debug("Block response: " + blockResponse.result)

//     // INFO: Handle max retries reached
//     if (blockResponse.result === 400) {
//         log.info("[fastSync] Peer is offline")
//         // TODO: Test this!
//         throw new PeerUnreachableError("Peer is offline")
//     }

//     if (blockResponse.result === 404) {
//         log.error("[fastSync] Block not found")
//         log.error("BLOCK TO ASK: " + blockToAsk)
//         log.error("PEER: " + peer.connection.string)

//         throw new BlockNotFoundError("Block not found")
//     }

//     if (blockResponse.result === 200) {
//         log.debug(
//             `[SYNC] downloadBlock - Block response received for block: ${blockToAsk}`,
//         )
//         const block = blockResponse.response as Block

//         if (!block) {
//             log.error("[downloadBlock] Block not received")
//             return false
//         }

//         return await syncBlock(block, peer)
//     }

//     return false
// }

// Helper function to ask for transactions in batches
export async function askTxsForBlocksBatch(
    blocks: Block[],
    peer: Peer,
): Promise<Record<string, Transaction>> {
    // Extract all unique transaction hashes from all blocks
    const allTxHashes = blocks.flatMap(
        block => block.content.ordered_transactions,
    )

    // Remove duplicates
    const uniqueTxHashes = [...new Set(allTxHashes)]

    // Fetch transactions in batches
    const batchSize = getSharedState.batchSyncTxSize
    const txMap = {}

    for (let i = 0; i < uniqueTxHashes.length; i += batchSize) {
        const batch = uniqueTxHashes.slice(i, i + batchSize)

        const txRequest: RPCRequest = {
            method: "nodeCall",
            params: [
                {
                    message: "getTxsByHashes",
                    data: { hashes: batch },
                    muid: null,
                },
            ],
        }

        const txResponse = await peer.call(txRequest, false)

        if (txResponse.result === 200) {
            const transactions = txResponse.response as Transaction[]
            // Build hash -> transaction map
            transactions.forEach(tx => {
                txMap[tx.hash] = tx
            })
        } else {
            log.error(
                "[askTxsForBlocksBatch] Failed to fetch batch of transactions",
            )
        }
    }

    return txMap
}

const FORK_RECOVERY_MAX_PEERS = 5

interface ForkRecoveryResult {
    block: Block
    txs: Transaction[]
    peer: Peer
}

/**
 * Ask other peers for their variant of a block we rejected, and return
 * the first variant that passes verifyBlock. Variants are deduplicated
 * by hash and tried most-served first; the rejected hash is skipped.
 * Returns null when no candidate serves a valid alternative — which
 * usually means the network agrees on the hash we rejected and we are
 * the forked node.
 */
async function resolveForkedBlock(
    blockNumber: number,
    rejectedHash: string,
    excludeIdentities: Set<string>,
): Promise<ForkRecoveryResult | null> {
    const selfId = getSharedState.publicKeyHex
    const candidates = peerManager
        .getAll()
        .filter(
            p =>
                p.sync.block >= blockNumber &&
                p.identity !== selfId &&
                !excludeIdentities.has(p.identity),
        )
        .slice(0, FORK_RECOVERY_MAX_PEERS)

    if (candidates.length === 0) {
        log.error(
            `[forkRecovery] No candidate peers to resolve block ${blockNumber}`,
        )
        return null
    }

    const request: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlocks",
                data: { start: blockNumber, limit: 1 },
                muid: null,
            },
        ],
    }

    const settled = await Promise.allSettled(
        candidates.map(async candidate => {
            const res = await Promise.race([
                candidate.call(request, false),
                sleep(FORK_POLL_TIMEOUT_MS).then(() => {
                    throw new Error(
                        `fork poll timed out after ${FORK_POLL_TIMEOUT_MS}ms`,
                    )
                }),
            ])
            if (res.result !== 200) {
                throw new Error(`getBlocks returned ${res.result}`)
            }
            const blocks = res.response as Block[]
            const block = blocks?.find(b => b.number === blockNumber)
            if (!block) {
                throw new Error(`no block ${blockNumber} in response`)
            }
            return { block, candidate }
        }),
    )

    const variants = new Map<string, { block: Block; peers: Peer[] }>()
    for (const result of settled) {
        if (result.status !== "fulfilled") continue
        const { block, candidate } = result.value
        if (block.hash === rejectedHash) continue
        const variant = variants.get(block.hash)
        if (variant) {
            variant.peers.push(candidate)
        } else {
            variants.set(block.hash, { block, peers: [candidate] })
        }
    }

    if (variants.size === 0) {
        log.error(
            `[forkRecovery] No alternative variant for block ${blockNumber}: ` +
                "polled peers agree with the hash we rejected",
        )
        return null
    }

    const ordered = [...variants.values()].sort(
        (a, b) => b.peers.length - a.peers.length,
    )

    for (const variant of ordered) {
        const verdict = await verifyBlock(variant.block as never)
        if (!verdict.valid) {
            log.error(
                `[forkRecovery] Variant ${variant.block.hash} of block ${blockNumber} is invalid: ${verdict.reason}`,
            )
            continue
        }

        for (const source of variant.peers) {
            try {
                const txs = await askTxsForBlock(variant.block, source)
                log.info(
                    `[forkRecovery] Recovered block ${blockNumber} (${variant.block.hash}) from ${source.identity}`,
                )
                return { block: variant.block, txs, peer: source }
            } catch (e) {
                log.error(
                    `[forkRecovery] Failed to fetch txs from ${source.identity}: ${e instanceof Error ? e.message : String(e)}`,
                )
            }
        }
    }

    return null
}

/**
 * Verify attrs, apply GCR edits and insert a synced block. Shared by
 * the batch loop and the fork-recovery path.
 *
 * @returns False if the block was already inserted concurrently
 */
async function applySyncedBlock(
    block: Block,
    blockTxs: Transaction[],
): Promise<boolean> {
    await assertNoUnreconciledGcrState()

    const exists = await Chain.getBlockByNumber(block.number)
    if (exists) {
        log.error("Block already exists, skipping ...")
        return false
    }

    // Merge peerlist
    await mergePeerlist(block)
    const applied = await verifyBlockAttrs(block, blockTxs)

    // Sync GCR tables
    await syncGCRTables(applied, block)

    await insertBlockOrHalt(block, blockTxs)

    log.info(
        `[batchDownloadBlocks] Block ${block.number} inserted successfully`,
    )
    return true
}

/**
 * Set once GCR edits have been persisted for a block that then failed to
 * insert. Local state is ahead of the chain from that moment on and nothing
 * in this process can reconcile it.
 */
let unreconciledGcrBlock: number | null = null

/**
 * Refuse to apply another synced block once state has drifted.
 *
 * The block-exists guard cannot catch this case: the failed block was never
 * inserted, so a retry would sail straight past it and apply the very same
 * GCR edits a second time, double-advancing nonces and balances. Fail fast
 * instead — every subsequent apply attempt would compound the corruption.
 *
 * The in-process latch alone is not enough: a restart clears it while the DB
 * still holds the orphaned edits. So we also check durable state — GCR edits
 * are stamped with the block that produced them, and an assignment above the
 * chain tip can only mean its block never landed.
 */
async function assertNoUnreconciledGcrState(): Promise<void> {
    if (unreconciledGcrBlock !== null) {
        throw new Error(
            "[applySyncedBlock] refusing to apply further blocks: GCR state for block " +
                `${unreconciledGcrBlock} was applied without its block and local state has ` +
                "drifted from the chain. The node must be resynced from scratch.",
        )
    }

    const orphanedBlock = await findOrphanedGcrBlock()
    if (orphanedBlock !== null) {
        unreconciledGcrBlock = orphanedBlock
        getSharedState.syncStatus = false
        throw new Error(
            "[applySyncedBlock] refusing to apply further blocks: GCR state for block " +
                `${orphanedBlock} exists but the block does not (chain tip is ` +
                `${await Chain.getLastBlockNumber()}). Local state has drifted from the ` +
                "chain — the node must be resynced from scratch.",
        )
    }
}

/**
 * Highest block stamped on a GCR assignment that sits above the chain tip,
 * or null when GCR state and chain history agree.
 */
async function findOrphanedGcrBlock(): Promise<number | null> {
    try {
        const tip = await Chain.getLastBlockNumber()
        const db = await Datasource.getInstance()
        const repo = db.getDataSource().getRepository(GCRAssignedTx)
        const highest = await repo
            .createQueryBuilder("a")
            .select("MAX(a.block_number)", "max")
            .getRawOne<{ max: number | string | null }>()

        const highestAssigned = Number(highest?.max ?? 0)
        if (!Number.isFinite(highestAssigned) || highestAssigned <= tip) {
            return null
        }
        return highestAssigned
    } catch (e) {
        // Never let the drift probe itself block syncing — on a fresh node the
        // table may not exist yet.
        log.debug(
            `[applySyncedBlock] could not check for orphaned GCR state: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return null
    }
}

/**
 * Insert a block whose GCR edits have ALREADY been applied.
 *
 * syncGCRTables persists GCR edits and neither it nor insertBlock accepts a
 * shared transaction manager, so an insert failure here leaves nonce/balance/
 * validator state ahead of the chain with no block authorizing it. Rethrowing
 * alone is not enough on either axis: callers up the fastSync chain swallow
 * errors, and the block-exists guard does not stop a retry from re-applying
 * the same edits. So mark the node unsynced AND latch the drift, which stops
 * it participating and blocks any further apply until an operator resyncs.
 */
async function insertBlockOrHalt(
    block: Block,
    blockTxs: Transaction[],
): Promise<void> {
    try {
        await Chain.insertBlock(block, blockTxs)
    } catch (e) {
        unreconciledGcrBlock = block.number
        getSharedState.syncStatus = false
        log.error(
            `[applySyncedBlock] FATAL: GCR state for block ${block.number} was applied ` +
                "but the block failed to insert; local state has drifted from the chain. " +
                "Marking the node unsynced and refusing further block application — " +
                "it must be resynced from scratch: " +
                `${e instanceof Error ? e.message : String(e)}`,
        )
        throw e
    }

    await recordSyncedBlock(block)
}

/**
 * Download and process a batch of blocks from a peer
 *
 * @param peer - The peer to download blocks from
 * @param startBlock - The first block number to download
 * @param endBlock - The last block number to download (inclusive)
 * @returns True if all blocks were downloaded and processed successfully
 */
async function batchDownloadBlocks(
    peer: Peer,
    startBlock: number,
    endBlock: number,
): Promise<boolean> {
    const batchSize = getSharedState.batchSyncBlockSize
    const totalBlocks = endBlock - startBlock + 1
    const limit = Math.min(totalBlocks, batchSize)

    log.debug(
        `[batchDownloadBlocks] Fetching ${limit} blocks from ${startBlock} to ${
            startBlock + limit - 1
        }`,
    )

    // Fetch batch of blocks
    const blocksRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlocks",
                data: { start: startBlock + limit - 1, limit },
                muid: null,
            },
        ],
    }

    const blocksResponse = await peer.longCall(blocksRequest, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    // Handle errors
    if (blocksResponse.result === 400) {
        log.error("[batchDownloadBlocks] Peer is offline")
        throw new PeerUnreachableError("Peer is offline")
    }

    if (blocksResponse.result === 404) {
        log.error("[batchDownloadBlocks] Blocks not found")
        throw new BlockNotFoundError("Blocks not found")
    }

    if (blocksResponse.result !== 200) {
        log.error(
            `[batchDownloadBlocks] Unexpected response: ${blocksResponse.result}`,
        )
        return false
    }

    const blocks = blocksResponse.response as Block[]
    if (!blocks || blocks.length === 0) {
        log.error("[batchDownloadBlocks] No blocks received")
        return false
    }

    // Fetch all transactions for all blocks in batch
    const txMap = await askTxsForBlocksBatch(blocks, peer)
    log.info(
        `[batchDownloadBlocks] Fetched ${
            Object.keys(txMap).length
        } unique transactions`,
    )

    // Process each block in order. Order matters for the height-stable
    // verify: each block's validator set (valid_at <= number-1) is already
    // persisted by the time the next block is checked.
    for (const block of blocks.sort((a, b) => a.number - b.number)) {
        const blockTxs = block.content.ordered_transactions
            .map(txHash => txMap[txHash])
            .filter(tx => !!tx)

        // AUDIT C2-deep — verify hash + signature quorum on EACH historical
        // block before insert (height-stable signer set). Fork-gated on
        // nonceEnforcement so pre-fork batch sync is byte-identical.
        if (
            isForkActive(
                "nonceEnforcement",
                getSharedState.lastBlockNumber ?? 0,
            )
        ) {
            const verdict = await verifyBlock(block as never)
            if (!verdict.valid) {
                log.error(
                    `[batchDownloadBlocks] Rejecting block ${block.number} (${block.hash}): ${verdict.reason}`,
                )

                const recovered = await resolveForkedBlock(
                    block.number,
                    block.hash,
                    new Set([peer.identity]),
                )

                if (!recovered) {
                    throw new ForkedPeerError(
                        `No valid variant found for forked block ${block.number}`,
                        null,
                    )
                }

                await applySyncedBlock(recovered.block, recovered.txs)

                // The rest of this batch builds on the rejected hash;
                // abandon it and continue from the recovery source
                throw new ForkedPeerError(
                    `Recovered forked block ${block.number} from ${recovered.peer.identity}`,
                    recovered.peer,
                )
            }
        }

        if (!(await applySyncedBlock(block, blockTxs))) {
            return false
        }
    }

    log.debug(
        `[batchDownloadBlocks] Successfully processed batch of ${blocks.length} blocks`,
    )
    return true
}

/**
 * Wait for the next block to be generated and download it
 *
 * @param peer - The peer to wait for the next block
 * @returns True if the block was downloaded successfully, false otherwise
 */
async function waitForNextBlock() {
    try {
        log.debug(
            "[waitForNextBlock] Waiting for next block 🥳🥳🥳🥳🥳🥳🥳🥳🥳",
        )
        const [newBlock, peer] = await Waiter.wait(
            Waiter.keys.SYNC_WAIT_FOR_BLOCK,
            120_000,
        )
        log.debug("[waitForNextBlock] Block received: " + newBlock.number)

        return await syncBlock(newBlock as Block, peer)
    } catch (error) {
        if (error instanceof TimeoutError) {
            log.error("[waitForNextBlock] Timeout waiting for next block")
            return false
        }

        handleError(error, "SYNC")
        return false
    }
}

/**
 * Trigger L2PS mempool sync with peer in background (non-blocking)
 */
function triggerL2PSSync(peer: Peer): void {
    if (!getSharedState.l2psJoinedUids?.length || !peer) {
        return
    }

    for (const l2psUid of getSharedState.l2psJoinedUids) {
        syncL2PSWithPeer(peer, l2psUid)
            .then(() => {
                log.debug(`[Sync] L2PS mempool synced: ${l2psUid}`)
            })
            .catch(error => {
                log.error(
                    `[Sync] L2PS sync failed for ${l2psUid}:`,
                    error.message,
                )
            })
    }
}

/**
 * Find the next available peer with highest block, excluding seen peers
 */
function findNextAvailablePeer(seenPeers: Set<string>): Peer | null {
    const highestBlockPeers = peerManager
        .getAll()
        .filter(p => p.sync.block === latestBlock())
        .filter(p => !seenPeers.has(p.identity))

    log.info(
        "[fastSync] Highest block peers: " +
            JSON.stringify(
                highestBlockPeers.map(p => p.connection.string),
                null,
                2,
            ),
    )

    if (highestBlockPeers.length === 0) {
        return null
    }

    log.info(
        "[fastSync] Switched to peer: " +
            highestBlockPeers[0].connection.string,
    )
    return highestBlockPeers[0]
}

/**
 * Request the blocks from the peer
 *
 * @returns True if the blocks were synced successfully, false otherwise
 */
async function requestBlocks(): Promise<boolean> {
    const seenPeers = new Set<string>()
    let peer = highestBlockPeer()

    while (getSharedState.lastBlockNumber < latestBlock()) {
        // if (latestBlock() === SecretaryManager.lastBlockRef) {
        //     log.debug("Attempting to sync consensus block, returning ...")
        //     return true
        // }

        log.debug("[requestBlocks] Requesting blocks ... 🔄🔄🔄🔄🔄🔄🔄🔄🔄")
        const startBlock = getSharedState.lastBlockNumber + 1
        const endBlock = latestBlock()
        const blocksToSync = endBlock - startBlock + 1

        log.debug(
            `[requestBlocks] Need to sync ${blocksToSync} blocks (${startBlock} to ${endBlock})`,
        )

        try {
            // Download batch of blocks
            const ok = await batchDownloadBlocks(peer, startBlock, endBlock)
            if (!ok) {
                seenPeers.add(peer.identity)
                const next = findNextAvailablePeer(seenPeers)
                if (!next) {
                    log.error("[requestBlocks] No more peers available to sync")
                    return false
                }
                peer = next
                continue
            }
            // Trigger L2PS sync
            triggerL2PSSync(peer)

            log.debug(
                `[requestBlocks] Batch sync completed. Current block: ${getSharedState.lastBlockNumber}`,
            )
        } catch (error) {
            handleError(error, "SYNC", { source: "block download" })
            // Handle chain head reached
            if (error instanceof BlockNotFoundError) {
                log.info(
                    "[requestBlocks] Reached end of available blocks on peer",
                )
                break
            }

            // Handle a forked peer: continue from the recovery source,
            // or abort the round safely when no valid variant exists
            if (error instanceof ForkedPeerError) {
                seenPeers.add(peer.identity)

                if (error.validSource) {
                    peer = error.validSource
                    log.info(
                        `[requestBlocks] Switched to fork-recovery source: ${peer.connection.string}`,
                    )
                    continue
                }

                log.error(
                    "[requestBlocks] No valid variant for forked block; aborting this sync round",
                )
                return false
            }

            // Handle peer unreachable - switch to next peer
            if (error instanceof PeerUnreachableError) {
                log.debug(
                    `[requestBlocks] Peer ${peer.identity} is unreachable. Switching to next peer.`,
                )
                seenPeers.add(peer.identity)

                // Find alternative peers with highest block
                const highestBlockPeers = peerManager
                    .getAll()
                    .filter(p => p.sync.block === latestBlock())
                    .filter(p => !seenPeers.has(p.identity))

                log.info(
                    `[requestBlocks] Available highest block peers: ${highestBlockPeers.length}`,
                )

                if (highestBlockPeers.length === 0) {
                    log.error("[requestBlocks] No more peers available to sync")
                    return false
                }

                peer = highestBlockPeers[0]
                log.info(
                    `[requestBlocks] Switched to peer: ${peer.connection.string}`,
                )

                // Retry the current batch with new peer
                continue
            }

            // Unknown error - log and break
            log.error(
                `[requestBlocks] Unexpected error during batch sync: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`,
            )
            return false
        }
    }

    log.info("[requestBlocks] Block sync completed successfully")
    return latestBlock() === getSharedState.lastBlockNumber
}

// REVIEW Applying GCREdits to the tables
export async function syncGCRTables(txs: Transaction[], block?: Block) {
    // apply only transaction with confirmed status
    const confirmedTxs = txs.filter(
        tx => tx.status === TRANSACTION_STATUS.CONFIRMED,
    )

    // sort transactions deterministic
    const sortedTxs = orderDeterministically(confirmedTxs)

    const nonceTrace = debugAssertionsEnabled()
        ? readNonceTrace(block?.attrs)
        : null

    if (!nonceTrace) {
        await HandleGCR.applyTransactions(sortedTxs, false)
        return
    }

    const traceAccounts = Object.keys(nonceTrace)
    const localBefore = await readNonces(traceAccounts)
    await HandleGCR.applyTransactions(sortedTxs, false)
    const localAfter = await readNonces(traceAccounts)

    assertSyncedNonceTrace(block.number, nonceTrace, localBefore, localAfter)
}

// Helper function to ask for the transactions in a block
export async function askTxsForBlock(
    block: Block,
    peer: Peer,
): Promise<Transaction[]> {
    if (
        Array.isArray(block.content.ordered_transactions) &&
        block.content.ordered_transactions.length === 0
    ) {
        return []
    }

    let request: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockTransactions",
                data: { blockHash: block.hash },
            },
        ],
    }

    let res = await peer.longCall(request, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    if (
        res.result === 200 &&
        Array.isArray(res.response) &&
        res.response.length > 0
    ) {
        return res.response as Transaction[]
    }

    // INFO: fetch all transactions by hashes
    request = {
        method: "nodeCall",
        params: [
            {
                message: "getTxsByHashes",
                data: { hashes: block.content.ordered_transactions },
            },
        ],
    }

    res = await peer.longCall(request, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    if (res.result === 200) {
        return res.response as Transaction[]
    }

    log.error("[askTxsForBlock] Failed to fetch transactions")
    return []
}

// Helper function to merge the peerlist from the last block
export async function mergePeerlist(block: Block): Promise<string[]> {
    const blockPeerlist = block.content.peerlist
    const ourPeerlist = PeerManager.getInstance().getPeers()
    const mergedPeers: string[] = []

    const ourPeerIdentities = new Set(ourPeerlist.map(peer => peer.identity))

    for (const peer of blockPeerlist) {
        if (typeof peer === "string") {
            continue
        }
        const peerObject = Peer.fromIPeer(peer)

        if (ourPeerIdentities.has(peerObject.identity)) {
            continue
        }

        const success = peerManager.addPeer(peerObject)
        if (success) {
            mergedPeers.push(peerObject.identity)
        }
    }

    // REVIEW: Phase 3c-3 - Exchange L2PS participation with newly discovered peers
    // Inform new peers about our L2PS networks (non-blocking)
    if (mergedPeers.length > 0 && getSharedState.l2psJoinedUids?.length > 0) {
        const newPeerObjects = mergedPeers
            .map(identity => peerManager.getPeer(identity))
            .filter((peer): peer is Peer => peer !== undefined)

        if (newPeerObjects.length > 0) {
            // Run in background, don't block blockchain sync
            exchangeL2PSParticipation(newPeerObjects).catch(error => {
                log.error(
                    "[Sync] L2PS participation exchange failed:",
                    error.message,
                )
            })
            log.debug(
                `[Sync] Exchanging L2PS participation with ${newPeerObjects.length} new peers`,
            )
        }
    }

    return mergedPeers
}

async function fastSyncRoutine(peers: Peer[] = []) {
    if (latestBlock() === getSharedState.lastBlockNumber) {
        log.debug("[fastSync] We're already synced!")
        return true
    }

    if (getSharedState.fastSyncCount === 0) {
        // INFO: Only run integrity checks on first sync
        const verified = await verifyLastBlockIntegrity(
            highestBlockPeer(),
            getSharedState.lastBlockNumber,
            getSharedState.lastBlockHash,
        )

        if (!verified) {
            log.error("[fastSync] Last block is not coherent")
            throw new Error(
                "[fastSync] Last block integrity check failed — node refusing to sync against incoherent chain",
            )
        }
    }

    while (!(await requestBlocks())) {
        if (getSharedState.isShuttingDown || getSharedState.fastSyncAborted)
            return false
        log.debug(
            "[fastSync] Request blocks failed, retrying ... ⛔️⛔️⛔️⛔️⛔️⛔️⛔️⛔️",
        )
        await sleep(500)
    }

    if (getSharedState.fastSyncCount === 0) {
        await Mempool.cleanMempool()

        // await waitForNextBlock()
        // while (!(await waitForNextBlock())) {
        //     if (getSharedState.isShuttingDown || getSharedState.fastSyncAborted)
        //         return false
        //     log.debug(
        //         "[fastSync] Failed to wait for next block, retrying ... ⛔️⛔️⛔️⛔️⛔️⛔️⛔️⛔️",
        //     )
        // }

        log.debug("[fastSync] Wait for next block complete! 🥳🥳🥳🥳🥳🥳🥳🥳🥳")
    }

    return latestBlock() === getSharedState.lastBlockNumber
}

export async function fastSync(
    peers: Peer[] = [],
    from: string,
): Promise<{ latestChainBlock: number; ourLatestBlock: number }> {
    if (getSharedState.inSyncLoop) {
        log.debug("[fastSync] Sync loop already running, skipping")

        return {
            latestChainBlock: latestBlock(),
            ourLatestBlock: getSharedState.lastBlockNumber,
        }
    }

    log.debug("[fastSync] Starting sync loop")
    // Set when we bail on a timeout while a detached fastSyncRoutine is still
    // running, so the finally below does not clear the abort out from under it.
    let abortedRunPending = false
    try {
        getSharedState.inSyncLoop = true
        getSharedState.fastSyncAborted = false

        // if our difference is greater than 2 blocks, set our sync status to false and broadcast
        if (getSharedState.syncStatus) {
            const networkHighest = latestBlock()
            const ourHighest = getSharedState.lastBlockNumber
            const difference = networkHighest - ourHighest

            if (difference >= 2) {
                getSharedState.syncStatus = false
                void BroadcastManager.broadcastOurSyncData()
                log.debug(
                    "[fastSync] Network highest block is more than 2 blocks ahead of our highest block, setting sync status to false and broadcasting",
                )
            }
        }

        let synced: boolean
        try {
            if (getSharedState.fastSyncCount > 0) {
                const result = await Promise.race([
                    syncLock
                        .runExclusive(async () => fastSyncRoutine(peers))
                        .then(v => ({
                            kind: "done" as const,
                            value: v,
                        })),
                    sleep(FAST_SYNC_TIMEOUT_MS).then(() => ({
                        kind: "timeout" as const,
                        value: false,
                    })),
                ])

                if (result.kind === "timeout") {
                    getSharedState.fastSyncAborted = true
                    abortedRunPending = true
                    log.warn(
                        `[fastSync] Timed out after ${FAST_SYNC_TIMEOUT_MS}ms, aborting`,
                    )
                    // Clear the abort flag only once the detached routine
                    // actually settles. Clearing it in the finally below
                    // would reset it before that routine reaches its next
                    // fastSyncAborted check, making the abort a no-op.
                    void syncLock.runExclusive(async () => {
                        getSharedState.fastSyncAborted = false
                    })
                    return {
                        latestChainBlock: latestBlock(),
                        ourLatestBlock: getSharedState.lastBlockNumber,
                    }
                }

                synced = result.value
            } else {
                synced = await fastSyncRoutine(peers)
            }
        } catch (error) {
            if (
                !(error instanceof SyncAssertionError) &&
                !(error instanceof BlockInvalidError)
            ) {
                throw error
            }
            log.error(
                "[fastSync] Sync assertion failed, aborting this sync round: " +
                    (error as Error).message,
            )
            synced = latestBlock() === getSharedState.lastBlockNumber
        }

        log.debug("[fastSync] Fast sync routine ended ⚪️⚪️⚪️⚪️⚪️⚪️⚪️⚪️⚪️")
        log.debug("[fastSync] Sync status: " + synced)
        getSharedState.syncStatus = synced
        void BroadcastManager.broadcastOurSyncData()

        log.debug("[fastSync] Broadcasted our sync data 📤📤📤📤📤📤📤📤📤")
        const lastBlockNumber = await Chain.getLastBlockNumber()
        log.debug(
            "[fastSync] DB Last block number after sync: " +
                lastBlockNumber +
                " from: " +
                from,
        )

        return {
            latestChainBlock: lastBlockNumber,
            ourLatestBlock: getSharedState.lastBlockNumber,
        }
    } finally {
        // On the timeout path the detached routine still holds syncLock and
        // has not yet observed the abort, so ownership of the flag passes to
        // the queued reset above.
        if (!abortedRunPending) {
            getSharedState.fastSyncAborted = false
        }
        getSharedState.inSyncLoop = false
        log.debug("[fastSync] Sync loop ended")
    }
}

/**
 * Block the consensus until peers reach the same block as us.
 *
 * @param lastBlockSignersOnly - If true, only wait for peers that signed the last block.
 *                               If false, wait for online peers that are level or 1 block behind.
 * @returns False if any peer is ahead of us (caller should abort the round); true otherwise.
 */
export async function waitForPeerStatus(
    lastBlockSignersOnly = true,
): Promise<boolean> {
    const POLL_MS = 100
    const TIMEOUT_MS = 30_000

    const ourBlock = getSharedState.lastBlockNumber
    const ourHash = getSharedState.lastBlockHash
    const selfId = getSharedState.publicKeyHex

    let signerIds: Set<string> | null = null

    if (lastBlockSignersOnly) {
        const signers = await getLastBlockSigners()
        const others = signers.filter(id => id !== selfId)
        if (others.length === 0) {
            log.debug("[waitForPeerStatus] No prior signers, skipping")
            return true
        }
        signerIds = new Set(others)
        log.only(
            "[waitForPeerStatus] Last block signers: " +
                JSON.stringify(Array.from(signerIds), null, 2),
        )
    }

    const start = Date.now()
    while (Date.now() - start < TIMEOUT_MS) {
        const onlinePeers = peerManager.getPeers()

        // Abort if any peer is ahead — we're stale and shouldn't drive consensus
        const ahead = onlinePeers.filter(
            p => p.status.online && p.sync.status && p.sync.block > ourBlock,
        )
        if (ahead.length > 0) {
            log.error(
                `[waitForPeerStatus] ${ahead.length} peer(s) ahead at block ${ourBlock}, aborting`,
            )
            return false
        }

        const waitFor = signerIds
            ? onlinePeers.filter(
                  p =>
                      signerIds.has(p.identity) &&
                      // only wait for peers that are upto 2 blocks behind us
                      getSharedState.lastBlockNumber - p.sync.block <= 2,
              )
            : onlinePeers.filter(p => p.sync.block >= ourBlock - 2)

        if (waitFor.length === 0) {
            log.only("[waitForPeerStatus] No target peers to wait for")
            return true
        }

        const isAligned = (p: Peer) =>
            p.sync.block === ourBlock && p.sync.block_hash === ourHash

        if (waitFor.every(isAligned)) {
            log.only(
                `[waitForPeerStatus] ${waitFor.length} peer(s) aligned at block ${ourBlock}, after ${Date.now() - start}ms`,
            )
            return true
        }

        const lagging = waitFor.filter(p => !isAligned(p)).length
        log.only(
            `[waitForPeerStatus] Waiting on ${lagging}/${waitFor.length} at block ${ourBlock}`,
        )
        log.only("😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒")
        await sleep(POLL_MS)
    }

    log.only(
        `[waitForPeerStatus] Timeout after ${TIMEOUT_MS}ms, proceeding best-effort 🙊`,
    )
    return true
}
