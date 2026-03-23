/**
 * PetriSecretary — Secretary-Coordinated Block Signing (Phase 9)
 *
 * Replaces the accept-and-sign model with independent verification:
 *   1. All shard members independently compile the same block (deterministic)
 *   2. Each member signs their block hash and submits to an elected secretary
 *   3. Secretary collects signatures, verifies 7/10 hashes match
 *   4. If match: assembles final block with all signatures and finalizes
 *   5. If <7/10 match: rejects, re-syncs mempools, retries once
 *
 * Secretary election: first peer in shard (same as legacy SecretaryManager).
 * Secretary offline: next peer in shard takes over.
 */

import type { Peer } from "@/libs/peer"
import type Block from "@/libs/blockchain/block"
import { getSharedState } from "@/utilities/sharedState"
import { hexToUint8Array, ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { mergeMempools } from "@/libs/consensus/v2/routines/mergeMempools"
import Mempool from "@/libs/blockchain/mempool_v2"
import log from "@/utilities/logger"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CollectionResult {
    /** Map of pubkey -> signature for members whose hash matched the secretary's */
    signatures: Record<string, string>
    /** Number of members whose hash matched */
    matchCount: number
    /** Number of members whose hash did NOT match */
    mismatchCount: number
    /** Number of members who didn't respond in time */
    timedOutCount: number
    /** Whether the BFT threshold was reached */
    agreed: boolean
}

export interface SubmitResult {
    /** Whether the secretary accepted our hash submission */
    accepted: boolean
    /** Status message from the secretary */
    status: string
}

// ─── Module-level collection state ───────────────────────────────────────────
// The secretary stores incoming hash submissions here.
// The RPC handler writes to this, collectBlockHashes reads from it.

interface PendingSubmission {
    blockHash: string
    signature: string
    blockNumber: number
}

let pendingSubmissions: Map<string, PendingSubmission> = new Map() // pubkey -> submission
let collectionResolve: (() => void) | null = null

/**
 * Called by the RPC handler when a member submits their block hash.
 * Stores the submission and notifies the collection loop if waiting.
 */
export function receiveBlockHashSubmission(
    senderPubkey: string,
    blockHash: string,
    signature: string,
    blockNumber: number,
): { status: string } {
    pendingSubmissions.set(senderPubkey, { blockHash, signature, blockNumber })
    log.debug(
        `[PetriSecretary] Received hash submission from ${senderPubkey.substring(0, 16)}... ` +
        `(${pendingSubmissions.size} collected)`,
    )

    // Wake up the collection loop if it's waiting
    if (collectionResolve) {
        collectionResolve()
        collectionResolve = null
    }

    return { status: "collected" }
}

/**
 * Reset the collection state. Called at the start of each collection round.
 */
export function resetCollection(): void {
    pendingSubmissions = new Map()
    collectionResolve = null
}

// ─── Secretary Election ──────────────────────────────────────────────────────

/**
 * Get the deterministic secretary identity from the full member set
 * (shard peers + ourselves). All nodes compute this identically because
 * getShard() is seeded deterministically and we add ourselves to the
 * sorted list so every node agrees on who is secretary.
 */
function getSecretaryIdentity(shard: Peer[]): string {
    const allIdentities = [
        ...shard.map(p => p.identity),
        getSharedState.publicKeyHex,
    ].sort((a, b) => a.localeCompare(b))
    return allIdentities[0]
}

/**
 * Elect the secretary for the current shard.
 * Returns the peer object for the secretary. If the secretary is us,
 * this still returns shard[0] (the caller should use isWeSecretary instead).
 */
export function electSecretary(shard: Peer[]): Peer {
    const secretaryId = getSecretaryIdentity(shard)
    const found = shard.find(p => p.identity === secretaryId)
    // If we are the secretary, return shard[0] as a fallback peer reference
    // (the caller should use isWeSecretary to decide the code path)
    return found ?? shard[0]
}

/**
 * Check if the local node is the secretary for this shard.
 * Compares our pubkey against the deterministic secretary identity
 * derived from the full member set (shard + ourselves).
 */
export function isWeSecretary(shard: Peer[]): boolean {
    return getSecretaryIdentity(shard) === getSharedState.publicKeyHex
}

// ─── Secretary: Collect Block Hashes ─────────────────────────────────────────

/**
 * Secretary-only: collect signed block hashes from shard members.
 *
 * Waits for submissions via the RPC handler (petri_submitBlockHash).
 * Also includes the secretary's own hash and signature.
 *
 * @param shard - Current shard members
 * @param block - The secretary's compiled candidate block
 * @param timeoutMs - How long to wait for submissions (default 5000ms)
 * @returns CollectionResult with signatures and agreement status
 */
export async function collectBlockHashes(
    shard: Peer[],
    block: Block,
    timeoutMs = 5000,
): Promise<CollectionResult> {
    resetCollection()

    const ourPubkey = getSharedState.publicKeyHex
    const expectedHash = block.hash
    const totalMembers = shard.length + 1 // shard peers + us
    const threshold = Math.floor((totalMembers * 2) / 3) + 1

    // Sign our own hash
    const ourSignature = await ucrypto.sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(expectedHash),
    )

    // Start with our own signature
    const signatures: Record<string, string> = {
        [ourPubkey]: uint8ArrayToHex(ourSignature.signature),
    }
    let matchCount = 1 // counting ourselves
    let mismatchCount = 0

    log.info(
        `[PetriSecretary] Collecting block hashes for block #${block.number} ` +
        `(need ${threshold}/${totalMembers}, timeout ${timeoutMs}ms)`,
    )

    // Wait for submissions with timeout
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline && matchCount < totalMembers) {
        // Check all pending submissions
        for (const [pubkey, submission] of pendingSubmissions) {
            if (signatures[pubkey]) continue // Already processed

            if (submission.blockNumber !== block.number) {
                log.warn(
                    `[PetriSecretary] Ignoring submission from ${pubkey.substring(0, 16)}... ` +
                    `— wrong block number (got ${submission.blockNumber}, expected ${block.number})`,
                )
                continue
            }

            if (submission.blockHash === expectedHash) {
                // Verify signature before accepting
                const isValid = await ucrypto.verify({
                    algorithm: getSharedState.signingAlgorithm,
                    message: new TextEncoder().encode(expectedHash),
                    signature: hexToUint8Array(submission.signature),
                    publicKey: hexToUint8Array(pubkey),
                })

                if (isValid) {
                    signatures[pubkey] = submission.signature
                    matchCount++
                    log.debug(
                        `[PetriSecretary] Valid matching hash from ${pubkey.substring(0, 16)}... ` +
                        `(${matchCount}/${threshold} needed)`,
                    )
                } else {
                    log.warn(
                        `[PetriSecretary] Invalid signature from ${pubkey.substring(0, 16)}...`,
                    )
                    mismatchCount++
                }
            } else {
                log.warn(
                    `[PetriSecretary] Hash MISMATCH from ${pubkey.substring(0, 16)}... ` +
                    `(theirs: ${submission.blockHash.substring(0, 16)}..., ` +
                    `ours: ${expectedHash.substring(0, 16)}...)`,
                )
                mismatchCount++
            }
        }

        // Early exit if we have enough
        if (matchCount >= threshold) break

        // Early exit if impossible to reach threshold
        const remaining = totalMembers - matchCount - mismatchCount
        if (matchCount + remaining < threshold) {
            log.warn("[PetriSecretary] Cannot reach threshold — too many mismatches")
            break
        }

        // Wait for more submissions or timeout
        const waitTime = Math.min(250, deadline - Date.now())
        if (waitTime > 0) {
            await new Promise<void>(resolve => {
                collectionResolve = resolve
                setTimeout(resolve, waitTime)
            })
        }
    }

    const timedOutCount = totalMembers - matchCount - mismatchCount
    const agreed = matchCount >= threshold

    log.info(
        `[PetriSecretary] Collection complete for block #${block.number}: ` +
        `${matchCount} match, ${mismatchCount} mismatch, ${timedOutCount} timeout ` +
        `(threshold=${threshold}, agreed=${agreed})`,
    )

    return {
        signatures,
        matchCount,
        mismatchCount,
        timedOutCount,
        agreed,
    }
}

// ─── Non-Secretary: Submit Block Hash ────────────────────────────────────────

/**
 * Non-secretary: compile our block, sign its hash, and submit to the secretary.
 *
 * @param secretary - The elected secretary peer
 * @param block - Our locally compiled candidate block
 * @returns SubmitResult indicating acceptance
 */
export async function submitBlockHash(
    secretary: Peer,
    block: Block,
): Promise<SubmitResult> {
    // Sign our block hash
    const signature = await ucrypto.sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(block.hash),
    )

    const signatureHex = uint8ArrayToHex(signature.signature)

    log.info(
        "[PetriSecretary] Submitting block hash to secretary " +
        `${secretary.identity.substring(0, 16)}... for block #${block.number}`,
    )

    try {
        const response = await secretary.longCall(
            {
                method: "consensus_routine",
                params: [
                    {
                        method: "petri_submitBlockHash",
                        params: [
                            block.hash,
                            signatureHex,
                            block.number,
                        ],
                    },
                ],
            },
            true,
            { retries: 2, sleepTime: 250 },
        )

        if (response.result === 200) {
            return { accepted: true, status: response.response?.status ?? "collected" }
        }

        log.warn(
            `[PetriSecretary] Secretary rejected our submission: ${response.response}`,
        )
        return { accepted: false, status: response.response ?? "rejected" }
    } catch (error) {
        log.error(`[PetriSecretary] Failed to submit to secretary: ${error}`)
        return { accepted: false, status: "error" }
    }
}

// ─── Mempool Re-sync ─────────────────────────────────────────────────────────

/**
 * Re-sync mempools across the shard after a hash mismatch.
 * Used before retrying block compilation.
 */
export async function handleMempoolResync(shard: Peer[]): Promise<void> {
    log.info("[PetriSecretary] Re-syncing mempools after hash mismatch")
    const mempool = await Mempool.getMempool()
    await mergeMempools({ transactions: mempool }, shard)
    log.info("[PetriSecretary] Mempool re-sync complete")
}

// ─── Secretary Failover ──────────────────────────────────────────────────────

/**
 * Handle secretary going offline. Attempts to connect to the secretary.
 * If offline, returns the next peer in shard order as the new secretary.
 *
 * @param shard - Current shard members
 * @returns Updated shard with the offline secretary removed, or null if secretary is online
 */
export async function handleSecretaryOffline(
    shard: Peer[],
): Promise<{ newShard: Peer[] | null; secretaryChanged: boolean }> {
    const secretary = electSecretary(shard)

    const isOnline = await secretary.connect()
    if (isOnline) {
        return { newShard: null, secretaryChanged: false }
    }

    // Double-check to avoid false negatives
    const isStillOnline = await secretary.connect()
    if (isStillOnline) {
        return { newShard: null, secretaryChanged: false }
    }

    log.warn(
        `[PetriSecretary] Secretary ${secretary.identity.substring(0, 16)}... is offline. ` +
        "Promoting next peer.",
    )

    // Remove the offline secretary, next in order becomes secretary
    const newShard = shard.filter(p => p.identity !== secretary.identity)
    return { newShard, secretaryChanged: true }
}
