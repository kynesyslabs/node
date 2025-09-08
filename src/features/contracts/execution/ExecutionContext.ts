/**
 * Execution context interface and utilities for contract execution
 */

export interface ExecutionContext {
    sender: string           // Transaction sender's public key
    contractAddress: string  // Contract's own address
    blockHeight: number     // Current block height
    timestamp: Date         // Execution timestamp
    value: bigint          // DEM sent with the call
}

export interface ExecutionRequest {
    contractSource: string
    methodName: string
    arguments: any[]
    executionContext: ExecutionContext
    contractState?: Record<string, any>  // Current contract state
}

export interface ExecutionResult {
    success: boolean
    returnValue: any
    callCount: number        // Function calls made (for fee calculation)
    gasUsed: bigint         // Gas/fee used
    stateChanges: Record<string, any>  // New state changes
    events: Array<{         // Events emitted
        name: string
        args: Record<string, any>
        blockHeight: number
        timestamp: Date
        txHash?: string
    }>
    error?: string          // Error message if failed
}

export interface CallCounter {
    count: number
}

/**
 * Utility to create execution context for contract calls
 */
export function createExecutionContext(params: {
    sender: string
    contractAddress: string
    blockHeight: number
    value?: bigint
}): ExecutionContext {
    return {
        sender: params.sender,
        contractAddress: params.contractAddress,
        blockHeight: params.blockHeight,
        timestamp: new Date(),
        value: params.value || 0n,
    }
}