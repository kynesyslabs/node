/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/
*/

import type { Block, Transaction } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"

import Chain from "../chain"
import log from "src/utilities/logger"
import Hashing from "src/libs/crypto/hashing"
import { serializeBlockContent } from "@/forks"
import TxValidatorPool from "./txValidatorPool"
import { verifyBlockTxSignatures } from "./verifyBlockTxSignatures"
import { getSharedState } from "@/utilities/sharedState"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import {
    getBoundCommittee,
    getEligiblePool,
} from "src/libs/consensus/v2/routines/getShard"
import { verifierThreshold } from "src/libs/consensus/v2/quorum"
import { isForkActive } from "@/forks/forkGates"
import { getErrorMessage } from "@/utilities/errorMessage"
import { debugAssertionsEnabled } from "src/libs/debug/nonceTrace"
import { checkOwnSignature } from "src/libs/identity/foreignSignature"

export interface BlockVerification {
    valid: boolean
    reason?: string
}

export function checkTimestampAgainstParent(
    blockTimestamp: unknown,
    parentTimestamp: unknown,
): BlockVerification {
    if (typeof blockTimestamp !== "number") {
        return { valid: false, reason: "block has no timestamp" }
    }
    if (typeof parentTimestamp !== "number") {
        return { valid: true }
    }

    const minDelta = getSharedState.getBlockTimestampMinDelta()
    if (blockTimestamp < parentTimestamp + minDelta) {
        return {
            valid: false,
            reason: `block timestamp ${blockTimestamp} is not after parent timestamp ${parentTimestamp} (+${minDelta}s)`,
        }
    }

    return { valid: true }
}

// Verified separately from the quorum tally, so a garbage entry under our key
// can never read as our signature, however the tally is computed.
async function carriesOurSignature(block: Block): Promise<boolean> {
    const ours = block.validation_data?.signatures?.[getSharedState.publicKeyHex]
    if (typeof ours !== "string") return false
    try {
        return await TxValidatorPool.getInstance().verify({
            algorithm: getSharedState.signingAlgorithm,
            message: new TextEncoder().encode(block.hash),
            signature: hexToUint8Array(ours),
            publicKey: hexToUint8Array(getSharedState.publicKeyHex),
        })
    } catch {
        return false
    }
}

/**
 * The members of `eligible` whose signature in `signatures` verifies over
 * `blockHash`. Sync and a producer about to commit count with this one
 * function, so they cannot disagree on which signatures count.
 */
export async function verifiedSignersOf(
    blockHash: string,
    signatures: Record<string, unknown>,
    eligible: Set<string>,
): Promise<Set<string>> {
    const message = new TextEncoder().encode(blockHash)
    const verifiedSigners = new Set<string>()
    await Promise.all(
        Object.entries(signatures).map(async ([identity, signature]) => {
            if (!eligible.has(identity)) return
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
                    `[verifyBlock] signature verify threw for ${identity}: ${getErrorMessage(e)}`,
                )
            }
        }),
    )
    return verifiedSigners
}

/** Whether `block` carries a verified signer quorum from the signers its height admits. */
async function checkSignerQuorum(block: Block): Promise<BlockVerification> {
    // Recompute the deterministic eligible signer pool for this height.
    // The forged shard is liveness-filtered and not reproducible here,
    // so signatures are validated against the pool it was drawn from.
    // Under committeeBinding the committee itself is chain data, and only
    // its members' signatures count: two blocks at one height then share
    // at least 2q - shardSize signers.
    const bound = isForkActive("committeeBinding", block.number)
    const signerSet = bound ? "bound committee" : "eligible signer pool"
    let pool: string[]
    try {
        pool = bound
            ? await getBoundCommittee(block.number - 1)
            : await getEligiblePool(block.number - 1)
    } catch (e) {
        return {
            valid: false,
            reason: `could not resolve ${signerSet}: ${getErrorMessage(e)}`,
        }
    }

    if (pool.length === 0) {
        return {
            valid: false,
            reason: `${signerSet} is empty`,
        }
    }
    const poolIdentities = new Set(pool)

    // Resolve eligible signer set for this block.
    const signatures = block.validation_data?.signatures
    if (!signatures || typeof signatures !== "object") {
        return {
            valid: false,
            reason: "block has no validation_data.signatures",
        }
    }

    // Verify each signature over the recomputed hash;
    const verifiedSigners = await verifiedSignersOf(
        block.hash,
        signatures,
        poolIdentities,
    )

    // The bar is pinned to shardSize, not to the forger's liveness view;
    // under quorumParity it is also the producer's, not shrunk by the pool.
    // committeeBinding implies the same bar: the overlap of two accepted
    // blocks is bounded against shardSize, not against a small committee.
    const threshold = verifierThreshold(
        getSharedState.shardSize,
        pool.length,
        bound || isForkActive("quorumParity", block.number),
    )
    if (verifiedSigners.size < threshold) {
        return {
            valid: false,
            reason: bound
                ? `insufficient verified committee signatures: ${verifiedSigners.size} of a bound committee of ${pool.length} (need ${threshold})`
                : `insufficient verified pool signatures: ${verifiedSigners.size} of a pool of ${pool.length} (need ${threshold})`,
        }
    }

    return { valid: true }
}

/**
 * Verify a synced block's hash + signature quorum.
 *
 * When the block's transactions are supplied (an empty array counts) they are re-judged at the
 * block's own height (hash coherence and signature preimage, including the
 * chain id once `signatureDomain` applies). Callers that already hold the
 * transactions should pass them: the block header alone commits to hashes,
 * so without them no transaction signature is checked here.
 */
export async function verifyBlock(
    block: Block,
    txs?: Transaction[],
): Promise<BlockVerification> {
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
        if (debugAssertionsEnabled()) {
            process.exit(1)
        }

        return {
            valid: false,
            reason: `last block hash mismatch: last block hash ${lastBlockHash}, block ${block.number}'s previous hash ${block.content.previousHash}`,
        }
    }

    const blockTimestamp = block.content.timestamp
    const prevTimestamp = prevBlock.content?.timestamp
    const parentVerdict = checkTimestampAgainstParent(
        blockTimestamp,
        prevTimestamp,
    )
    if (!parentVerdict.valid) {
        return parentVerdict
    }
    const tolerance = getSharedState.getBlockTimestampTolerance()
    const verifierNow = getNetworkTimestamp()
    if (blockTimestamp > verifierNow + tolerance) {
        return {
            valid: false,
            reason: `block timestamp ${blockTimestamp} is ${blockTimestamp - verifierNow}s in the verifier's future (tolerance ${tolerance}s)`,
        }
    }

    const quorum = await checkSignerQuorum(block)
    if (!quorum.valid) {
        return quorum
    }

    // After the quorum so a peer replaying one stray signature of ours on an
    // unaccepted block cannot stop this node from signing.
    if (await carriesOurSignature(block)) {
        checkOwnSignature({
            number: block.number,
            hash: block.hash,
            timestamp: blockTimestamp,
        })
    }

    // Last, because it is the expensive check: only a block that already has
    // its quorum is worth verifying transaction by transaction.
    if (txs !== undefined) {
        return await verifyBlockTxSignatures(block, txs)
    }

    return { valid: true }
}
