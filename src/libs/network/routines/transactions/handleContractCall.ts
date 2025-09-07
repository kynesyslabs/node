/**
 * Contract call transaction handler
 */

import { ContractCallPayload } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/TransactionSubtypes" // TODO Fix this by exporting when possible
import type { ContractData } from "@/features/contracts/types/ContractTypes"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"
import Sandbox from "@/features/contracts/execution/Sandbox"
import { createExecutionContext } from "@/features/contracts/execution/ExecutionContext"
import Chain from "@/libs/blockchain/chain"
import StateManager from "@/features/contracts/execution/StateManager"

/**
 * Handles contract call transactions
 */
export default async function handleContractCall(
    payload: ContractCallPayload,
    sender: string,
): Promise<{
    success: boolean
    message: string
    result?: any
    gasUsed?: bigint
    error?: string
}> {
    try {
        // REVIEW: Contract call handler for executing contract methods

        // 1. Validate contract exists
        var db = await Datasource.getInstance()
        var gcrRepo = db.getDataSource().getRepository(GCRMain)

        const contractAccount = await gcrRepo.findOne({
            where: { pubkey: payload.contractAddress },
        })

        if (!contractAccount) {
            return {
                success: false,
                message: "Contract not found",
                error: "Contract address does not exist",
            }
        }

        if (!contractAccount.contract) {
            return {
                success: false,
                message: "Invalid contract account",
                error: "Account exists but has no contract data",
            }
        }

        // 2. Validate contract is not frozen or paused
        if (contractAccount.contract.state.frozen) {
            return {
                success: false,
                message: "Contract is frozen",
                error: "Contract has been frozen and cannot be called",
            }
        }

        if (contractAccount.contract.state.paused) {
            return {
                success: false,
                message: "Contract is paused",
                error: "Contract is temporarily paused",
            }
        }

        // 3. Validate sender account exists
        const senderAccount = await gcrRepo.findOne({
            where: { pubkey: sender },
        })
        if (!senderAccount) {
            return {
                success: false,
                message: "Sender account not found",
                error: "Sender account does not exist",
            }
        }

        // 4. Check if sender has enough balance for call fee (1 DEM per call)
        const callFee = 1000000000000000000n // 1 DEM in wei
        if (senderAccount.balance < callFee) {
            return {
                success: false,
                message: "Insufficient balance for call fee",
                error: "Sender needs at least 1 DEM for contract call",
            }
        }

        // 5. Validate method exists in contract ABI (basic check for now)
        const contractABI = contractAccount.contract.code.abi
        const methodExists = contractABI.methods.some(
            method => method.name === payload.method,
        )

        // For Phase 3b, we just validate the method exists or allow any method if ABI is empty (basic contracts)
        if (contractABI.methods.length > 0 && !methodExists) {
            return {
                success: false,
                message: "Method not found",
                error: `Method '${payload.method}' not found in contract ABI`,
            }
        }

        // 6. Create state backup before execution (for rollback on errors)
        const stateBackup = await StateManager.createStateBackup(payload.contractAddress)
        if (!stateBackup.success) {
            return {
                success: false,
                message: "Failed to create state backup",
                error: stateBackup.error,
            }
        }

        // 7. Execute contract method in sandboxed environment
        // REVIEW: Phase 4 - Real contract execution using Bun Workers
        const currentBlockHeight = await Chain.getLastBlockNumber()
        const executionContext = createExecutionContext({
            sender,
            contractAddress: payload.contractAddress,
            blockHeight: currentBlockHeight,
            value: payload.value || 0n,
        })

        const sandbox = new Sandbox()
        const sandboxResult = await sandbox.execute({
            contractSource: contractAccount.contract.code.source,
            methodName: payload.method,
            arguments: payload.args,
            executionContext,
            contractState: contractAccount.contract.state.storage,
        })

        if (!sandboxResult.success) {
            // Rollback state on execution failure
            console.log("[handleContractCall] Contract execution failed, rolling back state")
            if (stateBackup.backup) {
                await StateManager.rollbackState(stateBackup.backup)
            }
            
            return {
                success: false,
                message: "Contract execution failed",
                error: sandboxResult.error || "Unknown execution error",
                gasUsed: sandboxResult.gasUsed,
            }
        }

        // 8. Apply state changes using StateManager with validation
        const stateResult = await StateManager.applyStateChanges(
            payload.contractAddress,
            sandboxResult.stateChanges || {},
        )

        if (!stateResult.success) {
            // Rollback state on state application failure
            console.log("[handleContractCall] State application failed, rolling back state")
            if (stateBackup.backup) {
                await StateManager.rollbackState(stateBackup.backup)
            }
            
            return {
                success: false,
                message: stateResult.message,
                error: stateResult.error,
                gasUsed: sandboxResult.gasUsed,
            }
        }

        // 9. Add events to contract (requires separate GCR update)
        var db = await Datasource.getInstance()
        var gcrRepo = db.getDataSource().getRepository(GCRMain)
        const updatedContractAccount = await gcrRepo.findOne({
            where: { pubkey: payload.contractAddress },
        })

        if (updatedContractAccount && updatedContractAccount.contract) {
            // Add events to contract
            if (sandboxResult.events && sandboxResult.events.length > 0) {
                const newEvents = sandboxResult.events.map(event => ({
                    ...event,
                    blockHeight: currentBlockHeight,
                    transactionHash: "", // Will be set later in transaction processing
                }))
                updatedContractAccount.contract.events.push(...newEvents)
            }

            // Update contract stats with actual execution data
            updatedContractAccount.contract.stats.callCount += sandboxResult.callCount
            updatedContractAccount.contract.stats.gasUsed += sandboxResult.gasUsed
            updatedContractAccount.contract.stats.lastExecuted = new Date()

            // Update contract metadata
            updatedContractAccount.contract.metadata.updatedAt = new Date()

            // Save updated contract data (events and stats)
            await gcrRepo.save(updatedContractAccount)
        }

        const executionResult = {
            returnValue: sandboxResult.returnValue,
            gasUsed: sandboxResult.gasUsed,
            success: true,
        }

        return {
            success: true,
            message: "Contract call executed successfully",
            result: executionResult.returnValue,
            gasUsed: executionResult.gasUsed,
        }
    } catch (error) {
        console.error("[handleContractCall] Error:", error)
        return {
            success: false,
            message: "Internal server error during contract call",
            error: error.toString(),
        }
    }
}
