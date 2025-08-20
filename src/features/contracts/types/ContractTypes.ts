/**
 * Contract-related type definitions for Demos smart contracts
 */

/**
 * Contract ABI definition for SDK interaction
 */
export interface ContractABI {
    methods: Array<{
        name: string
        inputs: Array<{
            name: string
            type: string
        }>
        outputs: Array<{
            type: string
        }>
        stateMutability: "view" | "nonpayable" | "payable"
    }>
    events: Array<{
        name: string
        inputs: Array<{
            name: string
            type: string
            indexed?: boolean
        }>
    }>
    constructor?: {
        inputs: Array<{
            name: string
            type: string
        }>
    }
}

/**
 * Contract metadata information
 */
export interface ContractMetadata {
    version: string
    createdAt: Date
    updatedAt: Date
    creator: string
    name?: string
    description?: string
}

/**
 * Contract code storage
 */
export interface ContractCode {
    source: string
    abi: ContractABI
    checksum: string
}

/**
 * Contract state storage
 */
export interface ContractState {
    storage: Record<string, any>
    frozen: boolean
    paused: boolean
}

/**
 * Contract event log entry
 */
export interface ContractEvent {
    name: string
    args: Record<string, any>
    blockHeight: number
    timestamp: Date
    transactionHash: string
}

/**
 * Contract execution statistics
 */
export interface ContractStats {
    callCount: number
    lastExecuted?: Date
    gasUsed: bigint
}

/**
 * Complete contract data structure stored in GCR
 */
export interface ContractData {
    metadata: ContractMetadata
    code: ContractCode
    state: ContractState
    events: ContractEvent[]
    stats: ContractStats
}