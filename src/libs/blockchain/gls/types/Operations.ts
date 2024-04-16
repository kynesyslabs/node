// import { TxFee } from "src/libs/blockchain/types/transactions"

// export interface OperationResult {
//     success: boolean
//     message: string
// }

// export interface Operation {
//     operator: string
//     actor: string
//     params: {} // Documented in the chain itself
//     hash: string
//     nonce: number
//     timestamp: number
//     status: boolean | "pending"
//     fees: TxFee
// }

// // WIP Making 'operations' registry more stable through db writing or file writing
// export interface OperationRegistrySlot {
//     operation: Operation
//     status: boolean | "pending"
//     result: OperationResult
//     timestamp: number
// }