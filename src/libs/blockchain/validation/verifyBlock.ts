/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/
*/

import type { Block } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"

import Chain from "../chain"
import log from "src/utilities/logger"
import Hashing from "src/libs/crypto/hashing"
import { serializeBlockContent } from "@/forks"
import TxValidatorPool from "./txValidatorPool"
import { getSharedState } from "@/utilities/sharedState"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import getCommonValidatorSeed from "src/libs/consensus/v2/routines/getCommonValidatorSeed"
import {
    getCommitteeFloor,
    getShardIdentities,
} from "src/libs/consensus/v2/routines/getShard"

export interface BlockVerification {
    valid: boolean
    reason?: string
}

/**
 * Verify a synced block's hash + signature quorum.
 */
export async function verifyBlock(block: Block): Promise<BlockVerification> {
    // Genesis has no shard or signatures
    if (block.number === 0) {
        return { valid: true }
    }

    // Recompute the block hash and compare with incoming.
    const expectedHash = Hashing.sha256(
        serializeBlockContent(block.content, block.number),
    )
    if (expectedHash !== block.hash) {
        return {
            valid: false,
            reason: `block hash mismatch: claimed ${block.hash}, recomputed ${expectedHash}`,
        }
    }

    const prevBlock = await Chain.getBlockByNumber(block.number - 1)
    if (!prevBlock) {
        return {
            valid: false,
            reason: `previous block ${block.number - 1} not found`,
        }
    }

    // Verify last block hash is the same as this block's previous hash
    const lastBlockHash = prevBlock.hash
    if (lastBlockHash !== block.content.previousHash) {
        // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
        log.error(
            `last block hash mismatch: last block hash ${lastBlockHash}, block ${block.number}'s previous hash ${block.content.previousHash}`,
        )
        process.exit(1)

        return {
            valid: false,
            reason: `last block hash mismatch: last block hash ${lastBlockHash}, block ${block.number}'s previous hash ${block.content.previousHash}`,
        }
    }

    const blockTimestamp = block.content.timestamp
    const prevTimestamp = prevBlock.content?.timestamp
    if (typeof blockTimestamp !== "number") {
        return { valid: false, reason: "block has no timestamp" }
    }
    if (typeof prevTimestamp === "number") {
        const minDelta = getSharedState.getBlockTimestampMinDelta()
        if (blockTimestamp < prevTimestamp + minDelta) {
            return {
                valid: false,
                reason: `block timestamp ${blockTimestamp} is not after parent timestamp ${prevTimestamp} (+${minDelta}s)`,
            }
        }
    }
    const tolerance = getSharedState.getBlockTimestampTolerance()
    const verifierNow = getNetworkTimestamp()
    if (blockTimestamp > verifierNow + tolerance) {
        return {
            valid: false,
            reason: `block timestamp ${blockTimestamp} is ${blockTimestamp - verifierNow}s in the verifier's future (tolerance ${tolerance}s)`,
        }
    }

    // Recompute the deterministic committee for this height
    let committee: string[]
    try {
        const { commonValidatorSeed } = await getCommonValidatorSeed(prevBlock)
        committee = await getShardIdentities(
            commonValidatorSeed,
            block.number - 1,
        )
    } catch (e) {
        return {
            valid: false,
            reason: `could not resolve committee: ${e instanceof Error ? e.message : String(e)}`,
        }
    }

    if (committee.length < getCommitteeFloor()) {
        return {
            valid: false,
            reason: `committee of ${committee.length} is below the floor of ${getCommitteeFloor()}`,
        }
    }
    const committeeIdentities = new Set(committee)

    // Resolve eligible signer set for this block.
    const signatures = block.validation_data?.signatures
    if (!signatures || typeof signatures !== "object") {
        return {
            valid: false,
            reason: "block has no validation_data.signatures",
        }
    }

    // Verify each signature over the recomputed hash;
    const message = new TextEncoder().encode(block.hash)
    const verifiedSigners = new Set<string>()
    await Promise.all(
        Object.entries(signatures).map(async ([identity, signature]) => {
            if (!committeeIdentities.has(identity)) return
            try {
                const ok = await TxValidatorPool.getInstance().verify({
                    algorithm: getSharedState.signingAlgorithm,
                    message,
                    signature: hexToUint8Array(signature as string),
                    publicKey: hexToUint8Array(identity),
                })
                if (ok) verifiedSigners.add(identity)
            } catch (e) {
                log.error(
                    `[verifyBlock] signature verify threw for ${identity}: ${e instanceof Error ? e.message : String(e)}`,
                )
            }
        }),
    )

    // Verify block was signed by 2/3 + 1 of its deterministic committee
    const threshold = Math.floor((committee.length * 2) / 3) + 1
    if (verifiedSigners.size < threshold) {
        return {
            valid: false,
            reason: `insufficient verified committee signatures: ${verifiedSigners.size}/${committee.length} (need ${threshold})`,
        }
    }

    return { valid: true }
}
