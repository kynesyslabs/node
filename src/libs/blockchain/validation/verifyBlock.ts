/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * verifyBlock — cryptographically validate a block received over the SYNC path
 * before it is inserted (audit C2).
 *
 * THE GAP: the consensus path already verifies each peer's block-hash vote
 * (broadcastBlockHash.ts), but the sync path (handleNewBlock -> syncBlock ->
 * Chain.insertBlock) copied `validation_data` verbatim and applied the block's
 * txs WITHOUT any check. An unauthenticated peer could POST a forged block at
 * height last+1 with empty/garbage signatures and have it inserted, poisoning
 * `lastBlockHash` (permanent consensus split) and applying arbitrary state.
 *
 * This function recomputes the canonical block hash, cryptographically
 * verifies every signature in `validation_data.signatures` against the
 * eligible validator set, and enforces the same 2/3 quorum the proposer path
 * uses — counting ONLY signatures from in-shard signers over the recomputed
 * hash.
 *
 * SCOPE / SAFETY:
 *   - Genesis (block 0) is exempt: it has no validator set and no signatures.
 *   - The eligible signer set is resolved HEIGHT-STABLY via
 *     `GCR.getGCRValidatorsAtBlock(block.number - 1)` (DB filter
 *     `valid_at <= height AND status="2"`), so verification is correct at the
 *     tip AND during deep/batch catch-up sync (blocks apply in order, so the
 *     validator records below N are persisted before N is verified). This
 *     superseded the earlier tip-only getShard() approach (audit C2-deep).
 *   - Fork-gated by the caller (nonceEnforcement, active @0): pre-fork the
 *     sync path keeps its legacy (no-verify) behaviour so re-syncing an old
 *     chain is byte-identical.
 *   - Never throws — returns {valid,reason} so the caller decides.
 */

import type { Block } from "@kynesyslabs/demosdk/types"

import Hashing from "src/libs/crypto/hashing"
import { serializeBlockContent } from "@/forks"
import { getSharedState } from "@/utilities/sharedState"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import log from "src/utilities/logger"
import TxValidatorPool from "./txValidatorPool"
import GCR from "src/libs/blockchain/gcr/gcr"

export interface BlockVerification {
    valid: boolean
    reason?: string
}

/**
 * Verify a synced block's hash + signature quorum. See file header for scope.
 */
export async function verifyBlock(block: Block): Promise<BlockVerification> {
    // Genesis (block 0) has no shard / signatures — accept (the
    // snapshot-restore + genesis path owns its own integrity).
    if (block.number === 0) {
        return { valid: true }
    }

    // 1. Recompute the canonical block hash and compare. Uses the block's own
    //    number for the fork-aware serializer (matches createBlock.ts).
    const expectedHash = Hashing.sha256(
        serializeBlockContent(block.content, block.number),
    )
    if (expectedHash !== block.hash) {
        return {
            valid: false,
            reason: `block hash mismatch: claimed ${block.hash}, recomputed ${expectedHash}`,
        }
    }

    // 2. Resolve the eligible signer set for this block.
    const signatures = block.validation_data?.signatures
    if (!signatures || typeof signatures !== "object") {
        return { valid: false, reason: "block has no validation_data.signatures" }
    }

    // Resolve the eligible signer set HEIGHT-STABLY from the persisted
    // validator table: the validators valid as of the parent block (N-1) are
    // exactly those eligible to sign block N. getGCRValidatorsAtBlock filters
    // `valid_at <= height AND status="2"` from DB, so it returns the correct
    // set for ANY height — at the tip AND during deep/batch catch-up sync
    // (blocks apply in order, so validator stake/exit changes below N are
    // already persisted when N is verified). This replaces the previous
    // getShard() call, which used the CURRENT online set and was only valid at
    // the tip — that was the C2 tip-only limitation (audit C2-deep).
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

    // 3. Verify each signature over the recomputed hash; count only signers in
    //    the validator set. Duplicate identities collapse via the Set of
    //    verified signers, so one validator cannot be double-counted.
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

    // 4. Quorum: same 2/3 threshold the proposer path uses (PoRBFT.isBlockValid).
    const threshold = Math.floor((validatorIdentities.size * 2) / 3) + 1
    if (verifiedSigners.size < threshold) {
        return {
            valid: false,
            reason: `insufficient verified signatures: ${verifiedSigners.size}/${validatorIdentities.size} (need ${threshold})`,
        }
    }

    return { valid: true }
}
