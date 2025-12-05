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
import HandleGCR, { GCRResult } from "@/libs/blockchain/gcr/handleGCR"
import type { GCREdit } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

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
    /** All affected accounts */
    affectedAccounts: string[]
    /** Details of each proof application */
    proofResults: {
        proofId: number
        l2psUid: string
        success: boolean
        message: string
        editsApplied: number
    }[]
}

/**
 * L2PS Consensus Integration
 * 
 * Called during consensus to apply pending L2PS proofs to L1 state.
 */
export default class L2PSConsensus {
    
    /**
     * Apply all pending L2PS proofs at consensus time
     * 
     * This is called from PoRBFT.ts during the consensus routine,
     * similar to how regular GCR edits are applied.
     * 
     * @param blockNumber - Current block number being forged
     * @param simulate - If true, verify proofs but don't apply edits
     * @returns Result of proof applications
     */
    static async applyPendingProofs(
        blockNumber: number,
        simulate: boolean = false
    ): Promise<L2PSConsensusResult> {
        const result: L2PSConsensusResult = {
            success: true,
            message: "",
            proofsApplied: 0,
            proofsFailed: 0,
            totalEditsApplied: 0,
            affectedAccounts: [],
            proofResults: []
        }

        try {
            // Get all pending proofs
            const pendingProofs = await L2PSProofManager.getProofsForBlock(blockNumber)

            if (pendingProofs.length === 0) {
                result.message = "No pending L2PS proofs to apply"
                return result
            }

            log.info(`[L2PS Consensus] Processing ${pendingProofs.length} pending proofs for block ${blockNumber}`)

            // Process each proof
            for (const proof of pendingProofs) {
                const proofResult = await this.applyProof(proof, blockNumber, simulate)
                result.proofResults.push(proofResult)

                if (proofResult.success) {
                    result.proofsApplied++
                    result.totalEditsApplied += proofResult.editsApplied
                    result.affectedAccounts.push(...proof.affected_accounts)
                } else {
                    result.proofsFailed++
                    result.success = false
                }
            }

            // Deduplicate affected accounts
            result.affectedAccounts = [...new Set(result.affectedAccounts)]

            result.message = `Applied ${result.proofsApplied}/${pendingProofs.length} L2PS proofs with ${result.totalEditsApplied} GCR edits`
            
            log.info(`[L2PS Consensus] ${result.message}`)

            return result

        } catch (error: any) {
            log.error(`[L2PS Consensus] Error applying proofs: ${error.message}`)
            result.success = false
            result.message = `Error: ${error.message}`
            return result
        }
    }

    /**
     * Apply a single proof's GCR edits to L1 state
     */
    private static async applyProof(
        proof: L2PSProof,
        blockNumber: number,
        simulate: boolean
    ): Promise<{
        proofId: number
        l2psUid: string
        success: boolean
        message: string
        editsApplied: number
    }> {
        const proofResult = {
            proofId: proof.id,
            l2psUid: proof.l2ps_uid,
            success: false,
            message: "",
            editsApplied: 0
        }

        try {
            // Step 1: Verify the proof
            const isValid = await L2PSProofManager.verifyProof(proof)
            if (!isValid) {
                proofResult.message = "Proof verification failed"
                if (!simulate) {
                    await L2PSProofManager.markProofRejected(proof.id, proofResult.message)
                }
                return proofResult
            }

            // Step 2: Apply each GCR edit to L1 state
            const editResults: GCRResult[] = []
            
            for (const edit of proof.gcr_edits) {
                // Get account from edit (for balance/nonce edits)
                const editAccount = 'account' in edit ? edit.account as string : proof.affected_accounts[0] || ''
                
                // Create a mock transaction for HandleGCR.apply
                const mockTx = {
                    hash: proof.transactions_hash,
                    content: {
                        type: "l2ps",
                        from: editAccount,
                        to: editAccount,
                        timestamp: Date.now()
                    }
                }

                const editResult = await HandleGCR.apply(
                    edit,
                    mockTx as any,
                    false, // not rollback
                    simulate
                )

                editResults.push(editResult)

                if (!editResult.success) {
                    proofResult.message = `GCR edit failed: ${editResult.message}`
                    
                    // If any edit fails, we need to rollback previous edits
                    if (!simulate) {
                        // Rollback already applied edits
                        for (let i = editResults.length - 2; i >= 0; i--) {
                            if (editResults[i].success) {
                                const rollbackEdit = { ...proof.gcr_edits[i], isRollback: true }
                                await HandleGCR.apply(rollbackEdit, mockTx as any, true, false)
                            }
                        }
                        
                        await L2PSProofManager.markProofRejected(proof.id, proofResult.message)
                    }
                    return proofResult
                }

                proofResult.editsApplied++
            }

            // Step 3: Mark proof as applied
            if (!simulate) {
                await L2PSProofManager.markProofApplied(proof.id, blockNumber)
            }

            proofResult.success = true
            proofResult.message = `Applied ${proofResult.editsApplied} GCR edits`

            log.info(`[L2PS Consensus] Proof ${proof.id} applied successfully: ${proofResult.editsApplied} edits`)

            return proofResult

        } catch (error: any) {
            proofResult.message = `Error: ${error.message}`
            if (!simulate) {
                await L2PSProofManager.markProofRejected(proof.id, proofResult.message)
            }
            return proofResult
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
                1000
            )

            // Filter by block number and rollback in reverse order
            const proofsToRollback = appliedProofs
                .filter(p => p.applied_block_number === blockNumber)
                .reverse()

            log.info(`[L2PS Consensus] Rolling back ${proofsToRollback.length} proofs for block ${blockNumber}`)

            for (const proof of proofsToRollback) {
                // Rollback each edit in reverse order
                for (let i = proof.gcr_edits.length - 1; i >= 0; i--) {
                    const edit = proof.gcr_edits[i]
                    const rollbackEdit = { ...edit, isRollback: true }
                    
                    // Get account from edit (for balance/nonce edits)
                    const editAccount = 'account' in edit ? edit.account as string : proof.affected_accounts[0] || ''
                    
                    const mockTx = {
                        hash: proof.transactions_hash,
                        content: {
                            type: "l2ps",
                            from: editAccount,
                            to: editAccount,
                            timestamp: Date.now()
                        }
                    }

                    await HandleGCR.apply(rollbackEdit, mockTx as any, true, false)
                }

                // Reset proof status to pending
                // This allows it to be reapplied in the next block
                const repo = await (await import("@/model/datasource")).default.getInstance()
                const ds = repo.getDataSource()
                const proofRepo = ds.getRepository((await import("@/model/entities/L2PSProofs")).L2PSProof)
                
                await proofRepo.update(proof.id, {
                    status: "pending",
                    applied_block_number: null,
                    processed_at: null
                })
            }

            log.info(`[L2PS Consensus] Rolled back ${proofsToRollback.length} proofs`)

        } catch (error: any) {
            log.error(`[L2PS Consensus] Error rolling back proofs: ${error.message}`)
            throw error
        }
    }

    /**
     * Get statistics about L2PS proofs for a block
     */
    static async getBlockStats(blockNumber: number): Promise<{
        proofsApplied: number
        totalEdits: number
        affectedAccounts: number
    }> {
        const appliedProofs = await L2PSProofManager.getProofs("", "applied", 10000)
        const blockProofs = appliedProofs.filter(p => p.applied_block_number === blockNumber)

        return {
            proofsApplied: blockProofs.length,
            totalEdits: blockProofs.reduce((sum, p) => sum + p.gcr_edits.length, 0),
            affectedAccounts: new Set(blockProofs.flatMap(p => p.affected_accounts)).size
        }
    }
}
