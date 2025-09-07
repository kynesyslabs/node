/**
 * Contract state management system
 * Handles state persistence, validation, and rollback for smart contracts
 */

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"
import type { ContractData } from "@/features/contracts/types/ContractTypes"

/**
 * State validation result interface
 */
export interface StateValidationResult {
    valid: boolean
    error?: string
    sizeBytes?: number
}

/**
 * State backup for rollback functionality
 */
export interface StateBackup {
    contractAddress: string
    previousState: Record<string, any>
    timestamp: Date
}

/**
 * StateManager handles all contract state operations
 * Provides atomic state updates with size validation and rollback capabilities
 */
export class StateManager {
    private static readonly MAX_STATE_SIZE_BYTES = 64 * 1024 // 64KB limit

    /**
     * Load contract state from GCR database
     */
    static async loadContractState(contractAddress: string): Promise<{
        success: boolean
        state?: Record<string, any>
        error?: string
    }> {
        try {
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            const contractAccount = await gcrRepo.findOne({
                where: { pubkey: contractAddress },
            })

            if (!contractAccount) {
                return {
                    success: false,
                    error: "Contract account not found",
                }
            }

            if (!contractAccount.contract) {
                return {
                    success: false,
                    error: "Account exists but has no contract data",
                }
            }

            // Return current state or empty object if no state exists
            return {
                success: true,
                state: contractAccount.contract.state.storage || {},
            }
        } catch (error) {
            console.error("[StateManager] Error loading contract state:", error)
            return {
                success: false,
                error: `Failed to load state: ${error instanceof Error ? error.message : String(error)}`,
            }
        }
    }

    /**
     * Validate state size against 64KB limit
     */
    static validateStateSize(state: Record<string, any>): StateValidationResult {
        try {
            const stateJson = JSON.stringify(state)
            const sizeBytes = Buffer.byteLength(stateJson, "utf8")

            if (sizeBytes > this.MAX_STATE_SIZE_BYTES) {
                return {
                    valid: false,
                    error: `State size ${sizeBytes} bytes exceeds limit of ${this.MAX_STATE_SIZE_BYTES} bytes`,
                    sizeBytes,
                }
            }

            return {
                valid: true,
                sizeBytes,
            }
        } catch (error) {
            return {
                valid: false,
                error: `State validation failed: ${error instanceof Error ? error.message : String(error)}`,
            }
        }
    }

    /**
     * Create state backup for rollback functionality
     */
    static async createStateBackup(contractAddress: string): Promise<{
        success: boolean
        backup?: StateBackup
        error?: string
    }> {
        const loadResult = await this.loadContractState(contractAddress)
        
        if (!loadResult.success) {
            return {
                success: false,
                error: `Failed to create backup: ${loadResult.error}`,
            }
        }

        return {
            success: true,
            backup: {
                contractAddress,
                previousState: loadResult.state || {},
                timestamp: new Date(),
            },
        }
    }

    /**
     * Apply state changes atomically with validation
     */
    static async applyStateChanges(
        contractAddress: string,
        stateChanges: Record<string, any>,
    ): Promise<{
        success: boolean
        message: string
        finalStateSize?: number
        error?: string
    }> {
        try {
            // Load current state
            const loadResult = await this.loadContractState(contractAddress)
            if (!loadResult.success) {
                return {
                    success: false,
                    message: "Failed to load current state",
                    error: loadResult.error,
                }
            }

            // Merge changes with current state
            const newState = {
                ...loadResult.state,
                ...stateChanges,
            }

            // Validate new state size
            const validation = this.validateStateSize(newState)
            if (!validation.valid) {
                return {
                    success: false,
                    message: "State size validation failed",
                    error: validation.error,
                }
            }

            // Apply changes to database
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            const contractAccount = await gcrRepo.findOne({
                where: { pubkey: contractAddress },
            })

            if (!contractAccount) {
                return {
                    success: false,
                    message: "Contract account not found during update",
                    error: "Contract address does not exist",
                }
            }

            // Update state in contract data
            if (contractAccount.contract) {
                contractAccount.contract.state.storage = newState
            }

            // Save to database
            await gcrRepo.save(contractAccount)

            return {
                success: true,
                message: "State changes applied successfully",
                finalStateSize: validation.sizeBytes,
            }
        } catch (error) {
            console.error("[StateManager] Error applying state changes:", error)
            return {
                success: false,
                message: "Internal error applying state changes",
                error: error instanceof Error ? error.message : String(error),
            }
        }
    }

    /**
     * Rollback state to previous backup
     */
    static async rollbackState(backup: StateBackup): Promise<{
        success: boolean
        message: string
        error?: string
    }> {
        try {
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            const contractAccount = await gcrRepo.findOne({
                where: { pubkey: backup.contractAddress },
            })

            if (!contractAccount) {
                return {
                    success: false,
                    message: "Contract account not found during rollback",
                    error: "Contract address does not exist",
                }
            }

            // Restore previous state
            if (contractAccount.contract) {
                contractAccount.contract.state.storage = backup.previousState
            }

            // Save to database
            await gcrRepo.save(contractAccount)

            console.log(`[StateManager] Rolled back state for contract ${backup.contractAddress} to ${backup.timestamp.toISOString()}`)

            return {
                success: true,
                message: "State rolled back successfully",
            }
        } catch (error) {
            console.error("[StateManager] Error rolling back state:", error)
            return {
                success: false,
                message: "Internal error during state rollback",
                error: error instanceof Error ? error.message : String(error),
            }
        }
    }

    /**
     * Get state size information for a contract
     */
    static async getStateInfo(contractAddress: string): Promise<{
        success: boolean
        info?: {
            sizeBytes: number
            sizeMB: number
            utilizationPercent: number
            keyCount: number
        }
        error?: string
    }> {
        try {
            const loadResult = await this.loadContractState(contractAddress)
            if (!loadResult.success) {
                return {
                    success: false,
                    error: loadResult.error,
                }
            }

            const state = loadResult.state || {}
            const validation = this.validateStateSize(state)
            const sizeBytes = validation.sizeBytes || 0

            return {
                success: true,
                info: {
                    sizeBytes,
                    sizeMB: sizeBytes / (1024 * 1024),
                    utilizationPercent: (sizeBytes / this.MAX_STATE_SIZE_BYTES) * 100,
                    keyCount: Object.keys(state).length,
                },
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            }
        }
    }
}

export default StateManager