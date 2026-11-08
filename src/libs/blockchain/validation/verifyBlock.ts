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
import { blockRowRefusal } from "./postgresStorable"
import { getSharedState } from "@/utilities/sharedState"
import { checkTimestampNotAhead } from "./timestampBound"
import { type SignerRule, signerRuleOf } from "./signerRule"
import { isForkActive } from "@/forks/forkGates"
import { getErrorMessage } from "@/utilities/errorMessage"
import { debugAssertionsEnabled } from "src/libs/debug/nonceTrace"
import { checkOwnSignature } from "src/libs/identity/foreignSignature"
import {
    certificateMessageOf,
    commitLockActive,
} from "src/libs/consensus/v2/commitLock/domain"
import {
    type CommitmentOptions,
    verifyCommitments,
} from "src/libs/blockchain/finality/commitments"

export interface BlockVerification {
    valid: boolean
    reason?: string
    /** Set when the parent's stored results are all the block disagrees with. */
    parentResultsMismatch?: boolean
}

export function checkTimestampAgainstParent(
    blockTimestamp: unknown,
    parentTimestamp: unknown,
    blockHeight: number,
): BlockVerification {
    if (typeof blockTimestamp !== "number") {
        return { valid: false, reason: "block has no timestamp" }
    }
    // Every honest clock reading is whole seconds; a fraction only adds
    // values the secretary can try for the block hash, and through it the
    // next committee seed. Gated because older blocks were never held to it.
    if (
        isForkActive("committeeBinding", blockHeight) &&
        !Number.isInteger(blockTimestamp)
    ) {
        return {
            valid: false,
            reason: `block timestamp ${blockTimestamp} is not a whole number of seconds`,
        }
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

export { checkTimestampNotAhead } from "./timestampBound"

// Verified separately from the quorum tally, so a garbage entry under our key
// can never read as our signature, however the tally is computed. Under
// commitLock the signature that can sit in a block is our precommit. Under
// canonicalSigners the tally counts our key in any case but tries one
// spelling of it, so the signature it counted for us is the one verified
// here, and no other: one verify, however many spellings the map holds.
// When it counted none, or before the fork, the exact key is looked up.
async function carriesOurSignature(
    block: Block,
    counted: Map<string, string>,
): Promise<boolean> {
    // null until the keypair is loaded
    const ownKey = getSharedState.publicKeyHex
    const countedOurs =
        isForkActive("canonicalSigners", block.number) &&
        typeof ownKey === "string"
            ? counted.get(ownKey.toLowerCase())
            : undefined
    const ours = countedOurs ?? block.validation_data?.signatures?.[ownKey]
    if (typeof ours !== "string") return false
    const message = certificateMessageOf(block)
    if (message === null) return false
    try {
        return await TxValidatorPool.getInstance().verify({
            algorithm: getSharedState.signingAlgorithm,
            message: new TextEncoder().encode(message),
            signature: hexToUint8Array(ours),
            publicKey: hexToUint8Array(getSharedState.publicKeyHex),
        })
    } catch {
        return false
    }
}

/**
 * The signatures in `signatures` by members of `eligible` that verify over
 * `signedMessage`: the block hash, or under commitLock the vote message.
 * With `canonical` (the `canonicalSigners` fork) identities compare in
 * lowercase, and a member whose key appears in two cases counts once, under
 * its lowercase identity with its first signature in map order, if that verifies.
 * Without it they compare as written, as they always have.
 * The keys whose verify could not run (the verifier threw) are added to
 * `unverified`: they are not counted, but that is this node's failure.
 */
export async function countedSignatures(
    signedMessage: string,
    signatures: Record<string, unknown>,
    eligible: Set<string>,
    canonical = false,
    unverified?: string[],
): Promise<Map<string, string>> {
    const message = new TextEncoder().encode(signedMessage)
    const members = canonical
        ? new Set([...eligible].map(id => id.toLowerCase()))
        : eligible
    const entries = Object.entries(signatures)
    // Under `canonical` a peer can spell one member's key in many cases, and
    // each spelling is a member. Only the first spelling in map order is
    // tried: a later one is skipped before any verify, so the work is at most
    // one verify per member. If that first signature does not verify the
    // member does not count, even when a later spelling carries a valid one.
    // That is deterministic for every node holding the same map, and it
    // grants a relay nothing new: it could already strip a signature.
    const tried = new Set<string>()
    const signers = await Promise.all(
        entries.map(async ([key, signature]) => {
            const identity = canonical ? key.toLowerCase() : key
            if (!members.has(identity)) return null
            if (canonical) {
                if (tried.has(identity)) return null
                tried.add(identity)
            }
            // A signature that is not hex is the block's fault; a verify that
            // throws after it is ours, and `unverified` tells the caller.
            let signatureBytes: Uint8Array
            try {
                signatureBytes = hexToUint8Array(signature as string)
            } catch (e) {
                log.error(
                    `[verifyBlock] signature verify threw for ${key}: ${getErrorMessage(e)}`,
                )
                return null
            }
            try {
                const ok = await TxValidatorPool.getInstance().verify({
                    algorithm: getSharedState.signingAlgorithm,
                    message,
                    signature: signatureBytes,
                    publicKey: hexToUint8Array(identity),
                })
                return ok ? identity : null
            } catch (e) {
                log.error(
                    `[verifyBlock] signature verify threw for ${key}: ${getErrorMessage(e)}`,
                )
                unverified?.push(key)
                return null
            }
        }),
    )
    const counted = new Map<string, string>()
    entries.forEach(([, signature], i) => {
        const identity = signers[i]
        if (identity !== null && !counted.has(identity)) {
            counted.set(identity, signature as string)
        }
    })
    return counted
}

/**
 * The members of `eligible` whose signature in `signatures` verifies over
 * `signedMessage`. Sync and a producer about to commit count with this one
 * function, so they cannot disagree on which signatures count.
 */
export async function verifiedSignersOf(
    signedMessage: string,
    signatures: Record<string, unknown>,
    eligible: Set<string>,
    canonical = false,
): Promise<Set<string>> {
    const counted = await countedSignatures(
        signedMessage,
        signatures,
        eligible,
        canonical,
    )
    return new Set(counted.keys())
}

interface SignedBlock {
    number: number
    hash: string
    validation_data?: {
        signatures?: Record<string, unknown>
        round?: unknown
    } | null
}

/**
 * A check of a block's signatures that could not run here: the signer set was
 * unreadable or a verify threw. It says nothing about the block, so a caller
 * retries later instead of rejecting what it was served.
 */
export class SignatureCheckUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SignatureCheckUnavailableError"
    }
}

type SignerTally =
    | { valid: false; reason: string; unavailable?: true }
    | {
          valid: true
          counted: Map<string, string>
          unverified: string[]
          poolSize: number
          bound: boolean
          threshold: number
      }

/**
 * The signatures `block` carries from the signers its height admits that
 * verify. The quorum check and the certificate sync stores both come from
 * here, so a block is never stored with a signature its quorum did not count.
 */
async function tallySigners(block: SignedBlock): Promise<SignerTally> {
    // Recompute the deterministic eligible signer pool for this height.
    // The forged shard is liveness-filtered and not reproducible here,
    // so signatures are validated against the pool it was drawn from.
    // Under committeeBinding the committee itself is chain data, and only
    // its members' signatures count: two blocks at one height then share
    // at least 2q - shardSize signers.
    const bound = isForkActive("committeeBinding", block.number)
    const signerSet = bound ? "bound committee" : "eligible signer pool"
    let rule: SignerRule
    try {
        rule = await signerRuleOf(block.number)
    } catch (e) {
        return {
            valid: false,
            reason: `could not resolve ${signerSet}: ${getErrorMessage(e)}`,
            unavailable: true,
        }
    }
    const pool = rule.members

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

    // Under commitLock the certificate is one round's precommits; a block
    // without a valid round has no certificate at all.
    const message = certificateMessageOf(block)
    if (message === null) {
        return {
            valid: false,
            reason: "block has no valid validation_data.round for its precommits",
        }
    }

    // Verify each signature over the recomputed hash (or its precommit message)
    const canonical = isForkActive("canonicalSigners", block.number)
    const unverified: string[] = []
    const counted = await countedSignatures(
        message,
        signatures,
        poolIdentities,
        canonical,
        unverified,
    )
    const poolSize = canonical
        ? new Set(pool.map(id => id.toLowerCase())).size
        : pool.length
    return {
        valid: true,
        counted,
        unverified,
        poolSize,
        bound,
        threshold: rule.threshold,
    }
}

/** Whether `block` carries a verified signer quorum from the signers its height admits. */
async function checkSignerQuorum(block: Block): Promise<BlockVerification> {
    return tallyQuorum(await tallySigners(block))
}

/** Whether a tally of a block's signers reaches its quorum. */
function tallyQuorum(tally: SignerTally): BlockVerification {
    if (tally.valid === false) {
        return { valid: false, reason: tally.reason }
    }
    const { counted, poolSize, bound, threshold } = tally

    // The bar is pinned to shardSize; see signerRuleOf.
    if (counted.size < threshold) {
        return {
            valid: false,
            reason: bound
                ? `insufficient verified committee signatures: ${counted.size} of a bound committee of ${poolSize} (need ${threshold})`
                : `insufficient verified pool signatures: ${counted.size} of a pool of ${poolSize} (need ${threshold})`,
        }
    }

    return { valid: true }
}

/**
 * Whether `block` hashes to its own hash and carries the signer quorum its
 * height admits, whichever parent it names. A peer cannot forge this, so a
 * certified block that differs from ours at the same height is evidence
 * against our chain, while an uncertified one is only the peer's word.
 */
export async function verifyBlockCertificate(
    block: Block,
): Promise<BlockVerification> {
    try {
        const expectedHash = Hashing.sha256(
            serializeBlockContent(block.content, block.number),
        )
        if (expectedHash !== block.hash) {
            return { valid: false, reason: "block hash mismatch" }
        }
        return await checkSignerQuorum(block)
    } catch (e) {
        return { valid: false, reason: getErrorMessage(e) }
    }
}

/**
 * A copy of `block` whose signature map holds only the signatures its
 * quorum counts: by the signers its height admits, verifying over its
 * certificate message. Sync stores this copy, so a signature that never
 * counted is neither kept nor served to peers again. The block hash does
 * not cover the signatures, so the copy is the same block; the caller's
 * block and its maps are left as they are.
 *
 * @throws when the signer set or the signed message cannot be resolved, or
 * when the counted signatures fall short of the quorum verifyBlock requires
 * (this tally verifies again, and a verify that fails now must not store a
 * certificate the block's own check would reject)
 * @throws SignatureCheckUnavailableError instead when the shortfall is this
 * node's: the signer set could not be read or a verify did not run
 */
export async function withCountedSignatures<T extends SignedBlock>(
    block: T,
): Promise<T> {
    const tally = await tallySigners(block)
    const quorum = tallyQuorum(tally)
    if (quorum.valid === false || tally.valid === false) {
        const why = `cannot rebuild the signatures of block ${block.number}: ${quorum.reason}`
        // Below quorum with a verify that never ran is not the block's fault
        const local =
            tally.valid === false
                ? tally.unavailable === true
                : tally.unverified.length > 0
        throw local
            ? new SignatureCheckUnavailableError(why)
            : new Error(why)
    }
    const validationData = {
        ...block.validation_data,
        signatures: Object.fromEntries(tally.counted),
    }
    // Descriptors, not assign: a peer's JSON can carry an own "__proto__" key,
    // and assign would run its setter and swap the copy's prototype
    return Object.create(Object.getPrototypeOf(block), {
        ...Object.getOwnPropertyDescriptors(block),
        validation_data: {
            value: validationData,
            enumerable: true,
            writable: true,
            configurable: true,
        },
    }) as T
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
    options: CommitmentOptions = {},
): Promise<BlockVerification> {
    // Genesis has no shard or signatures
    if (block.number === 0) {
        return { valid: true }
    }

    const unstorable = blockRowRefusal(block)
    if (unstorable !== null) {
        return { valid: false, reason: unstorable }
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

    const commitments = await verifyCommitments(block, prevBlock, options)
    if (!commitments.valid) {
        return commitments
    }

    const blockTimestamp = block.content.timestamp
    const prevTimestamp = prevBlock.content?.timestamp
    const parentVerdict = checkTimestampAgainstParent(
        blockTimestamp,
        prevTimestamp,
        block.number,
    )
    if (!parentVerdict.valid) {
        return parentVerdict
    }
    const aheadVerdict = checkTimestampNotAhead(blockTimestamp)
    if (!aheadVerdict.valid) {
        return aheadVerdict
    }

    const tally = await tallySigners(block)
    const quorum = tallyQuorum(tally)
    if (quorum.valid === false || tally.valid === false) {
        return quorum
    }

    // After the quorum so a peer replaying one stray signature of ours on an
    // unaccepted block cannot stop this node from signing.
    if (await carriesOurSignature(block, tally.counted)) {
        // Under commitLock the signing record keeps the round of each
        // precommit, so that is the time the record is compared against.
        checkOwnSignature({
            number: block.number,
            hash: block.hash,
            timestamp: commitLockActive(block.number)
                ? (block.validation_data as { round: number }).round
                : blockTimestamp,
        })
    }

    // Last, because it is the expensive check: only a block that already has
    // its quorum is worth verifying transaction by transaction.
    if (txs !== undefined) {
        return await verifyBlockTxSignatures(block, txs)
    }

    return { valid: true }
}
