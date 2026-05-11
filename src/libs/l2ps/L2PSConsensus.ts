/**
 * L2PS Consensus Integration
 *
 * Handles application of L2PS proofs at consensus time.
 * This is the key component that bridges L2PS private transactions
 * with L1 state changes.
 *
 * Flow at consensus:
 * 1. Consensus routine calls applyPendingL2PSProofs()
 * 2. Pending proofs are fetched and verified
 * 3. Verified proofs' GCR edits are applied to L1 state
 * 4. Proofs are marked as applied/rejected
 *
 * @module L2PSConsensus
 */

import L2PSProofManager from "./L2PSProofManager"
import { L2PSProof } from "@/model/entities/L2PSProofs"
import HandleGCR, { isGCRMainEdit } from "@/libs/blockchain/gcr/handleGCR"
import Chain from "@/libs/blockchain/chain"
import { Hashing } from "@kynesyslabs/demosdk/encryption"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import log from "@/utilities/logger"
import { getErrorMessage } from "@/utilities/errorMessage"
import { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * Result of applying a single proof
 */
interface ProofResult {
    proofId: number
    l2psUid: string
    success: boolean
    message: string
    editsApplied: number
}

/**
 * Result of applying L2PS proofs at consensus
 */
export interface L2PSConsensusResult {
    success: boolean
    message: string
    /** Number of proofs successfully applied */
    proofsApplied: number
    /** Number of proofs that failed verification/application */
    proofsFailed: number
    /** Total GCR edits applied to L1 */
    totalEditsApplied: number
    /** Total affected accounts count (privacy-preserving - not actual addresses) */
    affectedAccountsCount: number
    /** L1 batch transaction hashes created */
    l1BatchTxHashes: string[]
    /** Details of each proof application */
    proofResults: ProofResult[]
}

/**
 * L2PS Consensus Integration
 *
 * Called during consensus to apply pending L2PS proofs to L1 state.
 */
export default class L2PSConsensus {
    /**
     * Collect transaction hashes from applied proofs for mempool cleanup
     */
    private static collectTransactionHashes(
        appliedProofs: L2PSProof[],
    ): string[] {
        const confirmedTxHashes: string[] = []
        for (const proof of appliedProofs) {
            if (
                proof.transaction_hashes &&
                proof.transaction_hashes.length > 0
            ) {
                confirmedTxHashes.push(...proof.transaction_hashes)
                log.debug(
                    `[L2PS Consensus] Proof ${proof.id} has ${proof.transaction_hashes.length} tx hashes`,
                )
            } else if (proof.l1_batch_hash) {
                confirmedTxHashes.push(proof.l1_batch_hash)
                log.debug(
                    `[L2PS Consensus] Proof ${proof.id} using l1_batch_hash as fallback`,
                )
            } else {
                log.warning(
                    `[L2PS Consensus] Proof ${proof.id} has no transaction hashes to remove`,
                )
            }
        }
        return confirmedTxHashes
    }

    /**
     * Process applied proofs - cleanup mempool and create L1 batch
     */
    private static async processAppliedProofs(
        pendingProofs: L2PSProof[],
        proofResults: ProofResult[],
        blockNumber: number,
        result: L2PSConsensusResult,
    ): Promise<void> {
        const appliedProofs = pendingProofs.filter(
            proof => proofResults.find(r => r.proofId === proof.id)?.success,
        )

        // Create L1 batch transaction FIRST
        const batchTxHash = await this.createL1BatchTransaction(
            appliedProofs,
            blockNumber,
        )
        if (batchTxHash) {
            result.l1BatchTxHashes.push(batchTxHash)
        }

        // Update transaction statuses in l2ps_transactions table to 'confirmed'
        // This MUST happen after createL1BatchTransaction because that method sets them to 'batched'
        const confirmedTxHashes = this.collectTransactionHashes(appliedProofs)
        if (confirmedTxHashes.length > 0) {
            const deleted = await L2PSMempool.deleteByHashes(confirmedTxHashes)
            log.info(
                `[L2PS Consensus] Removed ${deleted} confirmed transactions from mempool`,
            )

            const L2PSTransactionExecutor = (
                await import("./L2PSTransactionExecutor")
            ).default
            for (const txHash of confirmedTxHashes) {
                try {
                    await L2PSTransactionExecutor.updateTransactionStatus(
                        txHash,
                        "confirmed",
                        blockNumber,
                        `Confirmed in block ${blockNumber}`,
                        batchTxHash || undefined,
                    )
                } catch (err) {
                    log.warning(
                        `[L2PS Consensus] Failed to update tx status for ${txHash.slice(0, 16)}...`,
                    )
                }
            }
            log.info(
                `[L2PS Consensus] Updated status to 'confirmed' for ${confirmedTxHashes.length} transactions`,
            )
        }
    }

    /**
     * Apply all pending L2PS proofs at consensus time
     */
    static async applyPendingProofs(
        blockNumber: number,
        simulate = false,
    ): Promise<L2PSConsensusResult> {
        const result: L2PSConsensusResult = {
            success: true,
            message: "",
            proofsApplied: 0,
            proofsFailed: 0,
            totalEditsApplied: 0,
            affectedAccountsCount: 0,
            l1BatchTxHashes: [],
            proofResults: [],
        }

        try {
            const pendingProofs =
                await L2PSProofManager.getProofsForBlock(blockNumber)

            if (pendingProofs.length === 0) {
                result.message = "No pending L2PS proofs to apply"
                return result
            }

            log.info(
                `[L2PS Consensus] Processing ${pendingProofs.length} pending proofs for block ${blockNumber}`,
            )

            // Process each proof
            for (const proof of pendingProofs) {
                const proofResult = await this.applyProof(
                    proof,
                    blockNumber,
                    simulate,
                )
                result.proofResults.push(proofResult)

                if (proofResult.success) {
                    result.proofsApplied++
                    result.totalEditsApplied += proofResult.editsApplied
                    result.affectedAccountsCount +=
                        proof.affected_accounts_count
                } else {
                    result.proofsFailed++
                    result.success = false
                }
            }

            // Process successfully applied proofs
            if (!simulate && result.proofsApplied > 0) {
                await this.processAppliedProofs(
                    pendingProofs,
                    result.proofResults,
                    blockNumber,
                    result,
                )
            }

            result.message = `Applied ${result.proofsApplied}/${pendingProofs.length} L2PS proofs with ${result.totalEditsApplied} GCR edits`
            log.info(`[L2PS Consensus] ${result.message}`)

            return result
        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Consensus] Error applying proofs: ${message}`)
            result.success = false
            result.message = `Error: ${message}`
            return result
        }
    }

    /**
     * Apply a single proof's GCR edits to L1 state
     */
    /**
     * Create mock transaction for GCR edit application
     */
    private static createMockTx(
        proof: L2PSProof,
        editAccount: string,
    ): Transaction {
        return {
            hash: proof.transactions_hash,
            content: {
                type: "l2psEncryptedTx",
                from: editAccount,
                to: editAccount,
                from_ed25519_address: editAccount,
                timestamp: Date.now(),
                gcr_edits: proof.gcr_edits,
            } as any,
            signature: null,
            ed25519_signature: null,
            status: null,
            blockNumber: null,
        }
    }

    /**
     * Rollback previously applied edits on failure
     */
    // private static async rollbackEdits(
    //     proof: L2PSProof,
    //     editResults: GCRResult[],
    //     mockTx: any,
    // ): Promise<void> {
    //     for (let i = editResults.length - 2; i >= 0; i--) {
    //         if (editResults[i].success) {
    //             const rollbackEdit = { ...proof.gcr_edits[i], isRollback: true }
    //             await HandleGCR.apply(rollbackEdit, mockTx, true, false)
    //         }
    //     }
    // }

    /**
     * Apply GCR edits from a proof
     */
    private static async applyGCREdits(
        proof: L2PSProof,
        simulate: boolean,
        proofResult: ProofResult,
    ): Promise<boolean> {
        // const editResults: GCRResult[] = []

        // for (const edit of proof.gcr_edits) {
        //     // Get account from the GCR edit itself (balance edits have account field)
        //     const editAccount = "account" in edit ? edit.account as string : ""
        //     const mockTx = this.createMockTx(proof, editAccount)

        //     const editResult = await HandleGCR.apply(edit, mockTx as any, false, simulate)
        //     editResults.push(editResult)

        //     if (!editResult.success) {
        //         proofResult.message = `GCR edit failed: ${editResult.message}`
        //         if (!simulate) {
        //             await this.rollbackEdits(proof, editResults, mockTx)
        //             await L2PSProofManager.markProofRejected(proof.id, proofResult.message)
        //         }
        //         return false
        //     }

        //     proofResult.editsApplied++
        // }

        // return true

        // REVIEW: Batch up all GCR Edits and apply them together

        let account = ""

        // loop through the proof.gcr_edits and find an account
        for (const edit of proof.gcr_edits) {
            if (isGCRMainEdit(edit)) {
                account = edit.account as string
                break
            }
        }

        if (!account) {
            proofResult.message = "No batchable account found in proof edits"
            return false
        }

        const mockTx = this.createMockTx(proof, account)
        const entities = await HandleGCR.prepareEntities([mockTx])
        const editResult = await HandleGCR.applyTransaction(
            entities,
            mockTx,
            false,
            simulate,
        )

        if (!editResult.success) {
            proofResult.message = `GCR edit failed: ${editResult.message}`

            if (!simulate) {
                // NOTE: We don't need to rollback here as that
                // is handled automatically in applyOne IF simulate was true
                await L2PSProofManager.markProofRejected(
                    proof.id,
                    proofResult.message,
                )
            }

            return false
        }

        if (!simulate) {
            await HandleGCR.gcrWriteMutex.runExclusive(async () => {
                await HandleGCR.saveGCREditChanges(
                    editResult.entities,
                    editResult.sideEffects,
                )
            })
        }

        proofResult.editsApplied += editResult.appliedEditsCount
        return true
    }

    private static async applyProof(
        proof: L2PSProof,
        blockNumber: number,
        simulate: boolean,
    ): Promise<ProofResult> {
        const proofResult: ProofResult = {
            proofId: proof.id,
            l2psUid: proof.l2ps_uid,
            success: false,
            message: "",
            editsApplied: 0,
        }

        try {
            // Verify the proof
            const isValid = await L2PSProofManager.verifyProof(proof)
            if (!isValid) {
                proofResult.message = "Proof verification failed"
                if (!simulate) {
                    await L2PSProofManager.markProofRejected(
                        proof.id,
                        proofResult.message,
                    )
                }
                return proofResult
            }

            // Apply GCR edits
            const success = await this.applyGCREdits(
                proof,
                simulate,
                proofResult,
            )
            if (!success) {
                return proofResult
            }

            // Mark proof as applied
            if (!simulate) {
                await L2PSProofManager.markProofApplied(proof.id, blockNumber)
            }

            proofResult.success = true
            proofResult.message = `Applied ${proofResult.editsApplied} GCR edits`
            log.info(
                `[L2PS Consensus] Proof ${proof.id} applied successfully: ${proofResult.editsApplied} edits`,
            )

            return proofResult
        } catch (error) {
            const message = getErrorMessage(error)
            proofResult.message = `Error: ${message}`
            if (!simulate) {
                await L2PSProofManager.markProofRejected(
                    proof.id,
                    proofResult.message,
                )
            }
            return proofResult
        }
    }

    /**
     * Create a single unified L1 batch transaction for all L2PS proofs in this block
     * This makes L2PS activity visible on L1 while keeping content encrypted
     *
     * @param proofs - Array of all applied proofs (may span multiple L2PS UIDs)
     * @param blockNumber - Block number where proofs were applied
     * @returns L1 batch transaction hash or null on failure
     */
    private static async createL1BatchTransaction(
        proofs: L2PSProof[],
        blockNumber: number,
    ): Promise<string | null> {
        try {
            // Group proofs by L2PS UID for the summary
            const l2psNetworks = [...new Set(proofs.map(p => p.l2ps_uid))]
            const totalTransactions = proofs.reduce(
                (sum, p) => sum + p.transaction_count,
                0,
            )
            const totalAffectedAccountsCount = proofs.reduce(
                (sum, p) => sum + p.affected_accounts_count,
                0,
            )

            // Create unified batch payload (only hashes and metadata, not actual content)
            const batchPayload = {
                block_number: blockNumber,
                l2ps_networks: l2psNetworks,
                proof_count: proofs.length,
                proof_hashes: proofs
                    .map(p => p.transactions_hash)
                    .sort((a, b) => a.localeCompare(b)),
                transaction_count: totalTransactions,
                affected_accounts_count: totalAffectedAccountsCount,
                timestamp: Date.now(),
            }

            // Generate deterministic hash for this batch
            const sortedL2psNetworks = [...l2psNetworks].sort((a, b) =>
                a.localeCompare(b),
            )
            const batchHash = Hashing.sha256(
                JSON.stringify({
                    blockNumber,
                    proofHashes: batchPayload.proof_hashes,
                    l2psNetworks: sortedL2psNetworks,
                }),
            )

            // Create single L1 transaction for all L2PS activity in this block
            // Using raw object to avoid strict type checking (l2psBatch is a system-only type)
            const l1BatchTx = {
                type: "l2psBatch",
                hash: `0x${batchHash}`,
                signature: {
                    type: "ed25519",
                    data: "", // System-generated, no actual signature needed
                },
                content: {
                    type: "l2psBatch",
                    from: "l2ps:consensus", // System sender for L2PS batch
                    to: "l2ps:batch",
                    amount: 0,
                    nonce: blockNumber,
                    timestamp: Date.now(),
                    data: [
                        "l2psBatch",
                        {
                            block_number: blockNumber,
                            l2ps_networks: l2psNetworks,
                            proof_count: proofs.length,
                            transaction_count: totalTransactions,
                            affected_accounts_count: totalAffectedAccountsCount,
                            // Encrypted batch hash - no actual transaction content visible
                            batch_hash: batchHash,
                            encrypted_summary: Hashing.sha256(
                                JSON.stringify(batchPayload),
                            ),
                        },
                    ],
                },
            }

            // Collect all transaction hashes from these proofs
            const txHashes = this.collectTransactionHashes(proofs)
            if (txHashes.length > 0) {
                const L2PSTransactionExecutor = (
                    await import("./L2PSTransactionExecutor")
                ).default
                for (const txHash of txHashes) {
                    try {
                        await L2PSTransactionExecutor.updateTransactionStatus(
                            txHash,
                            "batched",
                            blockNumber,
                            `Included in L1 batch 0x${batchHash}`,
                            `0x${batchHash}`,
                        )
                    } catch (err) {
                        log.warning(
                            `[L2PS Consensus] Failed to set status 'batched' for ${txHash.slice(0, 16)}...`,
                        )
                    }
                }
                log.info(
                    `[L2PS Consensus] Set status 'batched' for ${txHashes.length} transactions included in batch 0x${batchHash}`,
                )
            }

            // Insert into L1 transactions table
            const success = await Chain.insertTransaction(
                l1BatchTx as any,
                "confirmed",
            )

            if (success) {
                log.info(
                    `[L2PS Consensus] Created L1 batch tx ${l1BatchTx.hash} for block ${blockNumber} (${l2psNetworks.length} networks, ${proofs.length} proofs, ${totalTransactions} txs)`,
                )
                return l1BatchTx.hash
            } else {
                log.error(
                    `[L2PS Consensus] Failed to insert L1 batch tx for block ${blockNumber}`,
                )
                return null
            }
        } catch (error: unknown) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Consensus] Error creating L1 batch tx: ${message}`)
            return null
        }
    }

    /**
     * Rollback L2PS proofs for a failed block
     * Called when consensus fails and we need to undo applied proofs
     *
     * @param blockNumber - Block number that failed
     */
    static async rollbackProofsForBlock(blockNumber: number): Promise<void> {
        try {
            // Get proofs that were applied in this block
            const appliedProofs = await L2PSProofManager.getProofs(
                "", // all L2PS networks
                "applied",
                1000,
            )

            // Filter by block number and rollback in reverse order
            const proofsToRollback = appliedProofs
                .filter(p => p.applied_block_number === blockNumber)
                .reverse()

            log.info(
                `[L2PS Consensus] Rolling back ${proofsToRollback.length} proofs for block ${blockNumber}`,
            )

            for (const proof of proofsToRollback) {
                // // Rollback each edit in reverse order
                // for (let i = proof.gcr_edits.length - 1; i >= 0; i--) {
                //     const edit = proof.gcr_edits[i]
                //     const rollbackEdit = { ...edit, isRollback: true }

                //     // Get account from the GCR edit itself (balance edits have account field)
                //     const editAccount =
                //         "account" in edit ? (edit.account as string) : ""

                //     const mockTx = {
                //         hash: proof.transactions_hash,
                //         content: {
                //             type: "l2ps",
                //             from: editAccount,
                //             to: editAccount,
                //             timestamp: Date.now(),
                //         },
                //     }

                //     await HandleGCR.apply(
                //         rollbackEdit,
                //         mockTx as any,
                //         true,
                //         false,
                //     )
                // }

                // loop through the proof.gcr_edits and find an account
                let account = ""
                for (const edit of proof.gcr_edits) {
                    if (isGCRMainEdit(edit)) {
                        account = edit.account as string
                        break
                    }
                }

                if (!account) {
                    log.warning(
                        `[L2PS Consensus] No batchable account found in proof ${proof.id} for rollback, skipping`,
                    )
                    continue
                }

                const mockTx = this.createMockTx(proof, account)
                const entities = await HandleGCR.prepareEntities([mockTx])
                const editResult = await HandleGCR.applyTransaction(
                    entities,
                    mockTx,
                    true,
                    false,
                )

                if (!editResult.success) {
                    log.error(
                        `[L2PS Consensus] Rollback failed for proof ${proof.id}: ${editResult.message}`,
                    )
                    continue
                }

                await HandleGCR.saveGCREditChanges(
                    editResult.entities,
                    editResult.sideEffects,
                )

                // Reset proof status to pending
                // This allows it to be reapplied in the next block
                const repo = await (
                    await import("@/model/datasource")
                ).default.getInstance()
                const ds = repo.getDataSource()
                const proofRepo = ds.getRepository(
                    (await import("@/model/entities/L2PSProofs")).L2PSProof,
                )

                await proofRepo.update(proof.id, {
                    status: "pending",
                    applied_block_number: null,
                    processed_at: null,
                })
            }

            log.info(
                `[L2PS Consensus] Rolled back ${proofsToRollback.length} proofs`,
            )
        } catch (error: unknown) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Consensus] Error rolling back proofs: ${message}`)
            throw error
        }
    }

    /**
     * Get statistics about L2PS proofs for a block
     */
    static async getBlockStats(blockNumber: number): Promise<{
        proofsApplied: number
        totalEdits: number
        affectedAccountsCount: number
    }> {
        const appliedProofs = await L2PSProofManager.getProofs(
            "",
            "applied",
            10000,
        )
        const blockProofs = appliedProofs.filter(
            p => p.applied_block_number === blockNumber,
        )

        return {
            proofsApplied: blockProofs.length,
            totalEdits: blockProofs.reduce(
                (sum, p) => sum + p.gcr_edits.length,
                0,
            ),
            affectedAccountsCount: blockProofs.reduce(
                (sum, p) => sum + p.affected_accounts_count,
                0,
            ),
        }
    }
}
