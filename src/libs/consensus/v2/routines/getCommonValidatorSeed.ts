/*
 * CVSA (Common Validator Seed Algorithm)
 * 
 * ALGORITHM DESCRIPTION:
 * The CVSA generates a deterministic seed that any synced RPC can calculate independently:
 * 1. Retrieves the last 3 blocks from the blockchain
 * 2. Extracts hash and block number from each block  
 * 3. Retrieves the genesis block hash for chain anchoring
 * 4. Constructs string: "hash1:number1|hash2:number2|hash3:number3|genesis:genesisHash"
 * 5. Calculates SHA-256 hash of this string as the common validator seed
 * 
 * This seed is used for deterministic shard selection in the PoRBFT consensus mechanism.
 * All properly synced nodes will calculate the identical seed, while unsynced/malicious 
 * nodes will produce different seeds, enabling automatic network coordination.
 * 
 * SECURITY ANALYSIS:
 * 
 * Attack Vectors Analyzed:
 * 1. Block Content Manipulation - PREVENTED
 *    - Block hash covers ALL content (transactions, state, metadata)
 *    - Any tampering changes hash → CVSA breaks → immediately detected
 * 
 * 2. Genesis Substitution - PREVENTED  
 *    - Genesis hash inclusion prevents historical chain rewriting
 *    - Malicious genesis would produce different CVSA → fork detected
 * 
 * 3. Block Number Manipulation - PREVENTED
 *    - Sequential validation enforced by consensus
 *    - Skip/duplicate numbers break sequence validation
 * 
 * 4. Chain Fork Attack - REQUIRES BYZANTINE MAJORITY
 *    - Would need >67% validator control (PoRBFT threshold)
 *    - Not a CVSA vulnerability but fundamental consensus compromise
 * 
 * CRYPTOGRAPHIC GUARANTEES:
 * - Block hashes cryptographically commit to complete block content
 * - Genesis hash anchors entire chain history  
 * - Block numbers ensure sequential integrity
 * - SHA-256 provides collision resistance
 * 
 * RESULT: CVSA compatibility while tampering is cryptographically impossible
 * without controlling majority consensus (Byzantine fault tolerance assumption)
 */

import { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"
import { Blocks } from "src/model/entities/Blocks"
import Hashing from "src/libs/crypto/hashing"
import log from "src/utilities/logger"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function defaultLogger(message: string) {
    return log.debug(message)
}

export default async function getCommonValidatorSeed(
    lastBlock: Blocks = null,
    logger: (message: string) => void = defaultLogger,
): Promise<{
    commonValidatorSeed: string
    lastBlockNumber: number
}> {
    const blockCount = 3

    if (!lastBlock) {
        lastBlock = await Chain.getLastBlock()
    }

    const lastBlockNumber = lastBlock.number
    const lastFewBlocks: Blocks[] = [lastBlock]

    logger("LAST BLOCK NUMBER: " + lastBlock.number)
    logger("--------------------------------")
    logger("LAST BLOCK: " + lastBlock.hash)
    logger("--------------------------------")

    // Get remaining blocks (if available)
    while (lastFewBlocks.length < blockCount) {
        const block = await Chain.getBlockByNumber(
            lastBlockNumber - lastFewBlocks.length,
        )

        if (block) {
            lastFewBlocks.push(block)
        } else {
            // INFO: Should only happen iff lastBlockNumber < 3
            break
        }
    }

    // Get genesis block for chain anchoring
    const genesisBlock = await Chain.getGenesisBlock()
    const genesisHash = genesisBlock.hash

    // Build hash string: hash:number for each block + genesis
    const hashString = lastFewBlocks
        .map(block => `${block.hash}:${block.number}`)
        .join("|") + `|genesis:${genesisHash}`

    logger(
        "Block data: " +
            JSON.stringify(lastFewBlocks.map(b => ({ hash: b.hash, number: b.number }))),
    )
    logger("Genesis hash: " + genesisHash)
    logger("Hash string: " + hashString)
    logger("--------------------------------")

    // Calculate common validator seed
    const commonValidatorSeed = Hashing.sha256(hashString)

    // NOTE The common validator seed is set in the sharedState as soon as it is computed
    getSharedState.currentValidatorSeed = commonValidatorSeed
    logger(`Common validator seed: ${commonValidatorSeed}`)
    return { commonValidatorSeed, lastBlockNumber }
}
