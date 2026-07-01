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
import GCR from "src/libs/blockchain/gcr/gcr"
import Hashing from "src/libs/crypto/hashing"
import { serializeBlockContent } from "@/forks"
import TxValidatorPool from "./txValidatorPool"
import { getSharedState } from "@/utilities/sharedState"

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

    // Verify last block hash is the same as this block's previous hash
    const lastBlockHash = await Chain.getBlockHash(block.number - 1)
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

    // Retrieve eligible signer set for previous block
    let validatorIdentities: Set<string>
    try {
        const validators = (await GCR.getGCRValidatorsAtBlock(
            block.number - 1,
        )) as Array<{ address: string | null }>
        validatorIdentities = new Set(
            validators
                .map(v => v.address)
                .filter((a): a is string => typeof a === "string"),
        )
    } catch (e) {
        return {
            valid: false,
            reason: `could not resolve validator set: ${e instanceof Error ? e.message : String(e)}`,
        }
    }

    if (validatorIdentities.size === 0) {
        return { valid: false, reason: "empty validator set for block" }
    }

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
            if (!validatorIdentities.has(identity)) return
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

    // Verify block was signed by 2/3 + 1 of the validator set
    const threshold = Math.floor((getSharedState.shardSize * 2) / 3) + 1
    if (verifiedSigners.size < threshold) {
        return {
            valid: false,
            reason: `insufficient verified signatures: ${verifiedSigners.size}/${getSharedState.shardSize} (need ${threshold})`,
        }
    }

    return { valid: true }
}
