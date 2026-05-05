import Block from "src/libs/blockchain/block"
import { type NativeTablesHashes } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import log from "src/utilities/logger"
import { Transaction } from "@kynesyslabs/demosdk/types"
import Peer from "src/libs/peer/Peer"
import hashGCRTables from "src/libs/blockchain/gcr/gcr_routines/hashGCR"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"

export async function createBlock(
    orderedTransactions: Transaction[],
    commonValidatorSeed: string,
    previousBlockHash: string,
    blockNumber: number,
    peerlist: Peer[],
): Promise<Block> {
    if (getSharedState.candidateBlock) {
        log.warning(
            "Candidate block already exists: we should not overwrite it (returning the existing one)",
        )
        // ? Number check?
        return getSharedState.candidateBlock
    }
    // Creating the block
    const block = new Block()
    block.content.ordered_transactions = orderedTransactions.map(
        transaction => transaction.hash,
    )
    block.content.previousHash = previousBlockHash
    block.content.peerlist = peerlist
    block.proposer = commonValidatorSeed // This is the shard identifier
    block.number = blockNumber
    block.content.native_tables_hashes = await hashNativeTables()
    block.content.timestamp = getSharedState.lastConsensusTime
    block.content.timestamp = getSharedState.lastConsensusTime
    block.hash = Hashing.sha256(JSON.stringify(block.content))
    // Signing the block and adding the signature to the block validation data

    const blockSignature = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(block.hash),
    )

    // ? Probably to remove once we have the mechanism working for v2
    if (!block.validation_data) {
        block.validation_data = { signatures: {} }
    }

    block.validation_data.signatures[getSharedState.publicKeyHex] = // ! Define a decent type for validation_data
        uint8ArrayToHex(blockSignature.signature)

    /* NOTE - The block timestamp is the average timestamp of the shard 
    see averageTimestamp.ts for more details */

    const { commonValidatorSeed: nextProposer } = await getCommonValidatorSeed(
        block as any,
    )
    log.debug(`nextProposer: ${nextProposer}`)
    block.next_proposer = nextProposer
    // Add the candidate to the shared state
    getSharedState.candidateBlock = block
    return block
}

// NOTE Proxy for hashGCRTables
export async function hashNativeTables(): Promise<NativeTablesHashes> {
    // TODO
    const hashes: NativeTablesHashes = await hashGCRTables()
    // TODO
    return hashes
}
