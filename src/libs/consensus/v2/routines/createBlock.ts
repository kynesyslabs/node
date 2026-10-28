import Block from "src/libs/blockchain/block"
import { type NativeTablesHashes } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import log from "src/utilities/logger"
import { Transaction } from "@kynesyslabs/demosdk/types"
import hashGCRTables from "src/libs/blockchain/gcr/gcr_routines/hashGCR"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import { serializeBlockContent } from "@/forks"
import Chain from "src/libs/blockchain/chain"
import {
    assertSigningAllowed,
    checkBlockSignature,
    recordBlockSignature,
    SigningRecordError,
} from "src/libs/identity/signingRecord"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import {
    commitLockActive,
    isRound,
    prevoteMessage,
    roundAheadRefusal,
} from "../commitLock/domain"
import { CommitLockError } from "../commitLock/lockStore"
import { recordPrevote } from "../commitLock/roundState"

export interface CandidateOptions {
    /** The attempt's round; required under commitLock, where it is signed. */
    round?: number
    /**
     * The hash a rebuilt locked or proof-of-lock block must reproduce. A
     * different hash is refused before anything is signed.
     */
    expectedHash?: string
}

export async function resolveBlockTimestamp(
    secretaryTimestamp: number,
    blockNumber: number,
): Promise<number> {
    const parentBlock = await Chain.getBlockByNumber(blockNumber - 1)
    const parentTimestamp = parentBlock?.content?.timestamp

    if (typeof parentTimestamp !== "number") {
        return secretaryTimestamp
    }

    const floor = parentTimestamp + getSharedState.getConsensusTime()
    if (secretaryTimestamp >= floor) {
        return secretaryTimestamp
    }

    log.warning(
        `[createBlock] Secretary timestamp ${secretaryTimestamp} for block ${blockNumber} ` +
            `is below the floor of ${floor} (parent ${parentTimestamp} + ${getSharedState.getConsensusTime()}s): clamping`,
    )
    return floor
}

export async function createBlock(
    orderedTransactions: Transaction[],
    commonValidatorSeed: string,
    previousBlockHash: string,
    blockNumber: number,
    peerlist: string[],
    blockTimestamp: number,
    options: CandidateOptions = {},
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
    block.content.peerlist =
        peerlist as unknown as typeof block.content.peerlist
    block.proposer = commonValidatorSeed // This is the shard identifier
    block.number = blockNumber
    block.content.native_tables_hashes = await hashNativeTables(blockNumber)
    block.content.timestamp = await resolveBlockTimestamp(
        blockTimestamp,
        blockNumber,
    )
    // REVIEW: P2 — route block hashing through the fork-aware serializer.
    // The block's own number is the correct height for gating.
    block.hash = Hashing.sha256(
        serializeBlockContent(block.content, blockNumber),
    )
    // Signing the block and adding the signature to the block validation data

    const genesisHash = getSharedState.genesisBlockHash
    if (!genesisHash) {
        throw new SigningRecordError(
            "genesis block hash is not loaded; refusing to sign",
        )
    }

    if (commitLockActive(blockNumber)) {
        return await prevoteCandidate(block, options)
    }
    const round = {
        genesisHash,
        height: blockNumber,
        timestamp: block.content.timestamp,
        hash: block.hash,
    }
    const policy = { production: getSharedState.PROD }
    checkBlockSignature(getSharedState.identityFile, round, policy)

    const blockSignature = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(block.hash),
    )

    // Persisted before the block is returned so the signature cannot leave
    // the process without a record of it, and only once signing succeeded.
    recordBlockSignature(getSharedState.identityFile, round, policy)

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

/**
 * Under commitLock the candidate carries our prevote, bound to the height
 * and round. Prevotes are not kept in the signing record: only a precommit
 * can sit in a certificate, and the commit lock decides what this member
 * prevotes. Signing still stops when the key may run elsewhere.
 */
async function prevoteCandidate(
    block: Block,
    options: CandidateOptions,
): Promise<Block> {
    const { round, expectedHash } = options
    if (!isRound(round)) {
        throw new CommitLockError(
            `no round for the prevote on block ${block.number}; refusing to sign`,
        )
    }
    const ahead = roundAheadRefusal(round, getNetworkTimestamp())
    if (ahead) {
        throw new CommitLockError(
            `${ahead}; refusing to prevote block ${block.number}`,
        )
    }
    if (expectedHash !== undefined && expectedHash !== block.hash) {
        throw new CommitLockError(
            `rebuilt block ${block.number} hashes to ${block.hash}, not the locked ${expectedHash}; refusing to sign`,
        )
    }
    assertSigningAllowed(getSharedState.identityFile)

    const prevote = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(prevoteMessage(block.number, round, block.hash)),
    )
    block.validation_data = {
        signatures: {
            [getSharedState.publicKeyHex]: uint8ArrayToHex(prevote.signature),
        },
        round,
    }
    recordPrevote({
        height: block.number,
        round,
        hash: block.hash,
        inputs: {
            previousHash: block.content.previousHash,
            orderedTransactions: [...block.content.ordered_transactions],
            peerlist: [...(block.content.peerlist as unknown as string[])],
            timestamp: block.content.timestamp,
        },
    })

    const { commonValidatorSeed: nextProposer } = await getCommonValidatorSeed(
        block as any,
    )
    block.next_proposer = nextProposer
    getSharedState.candidateBlock = block
    return block
}

// NOTE Proxy for hashGCRTables
export async function hashNativeTables(
    blockNumber?: number,
): Promise<NativeTablesHashes> {
    // TODO
    const hashes: NativeTablesHashes = await hashGCRTables(blockNumber)
    // TODO
    return hashes
}
