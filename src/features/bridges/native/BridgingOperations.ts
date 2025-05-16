// TODO This module defines and manages the operations for the native bridge
import Hashing from "@/libs/crypto/hashing"
import Transaction from "@/libs/blockchain/transaction"
import { bridge } from "@kynesyslabs/demosdk"

export class BridgingManagement {
    // TODO Implement the operations for the native bridge
    private static instance: BridgingManagement

    public operations: Map<string, bridge.NativeBridgeOperation[]> = new Map() // Address -> Operations
    public operationsByHash: Map<string, bridge.NativeBridgeOperation> = new Map() // Hash -> Operation

    public static getInstance(): BridgingManagement {
        if (!this.instance) {
            this.instance = new BridgingManagement()
        }
        return this.instance
    }

    private constructor() {}

    /**
     * Adds a new operation to the operations map
     * @param operation The operation to add
     * @returns The hash of the operation
     */
    public addOperation(
        operation: bridge.NativeBridgeOperation,
    ): string {
        const address = operation.originAddress
        if (!this.operations.has(address)) {
            this.operations.set(address, [])
        }
        this.operations.get(address)?.push(operation)
        const hash = Hashing.sha256(JSON.stringify(operation))
        this.operationsByHash.set(hash, operation)
        return hash
    }

    public getOperations(): bridge.NativeBridgeOperation[] {
        return Array.from(this.operations.values()).flat()
    }

    public getOperationByHash(
        hash: string,
    ): bridge.NativeBridgeOperation {
        const operation = this.operationsByHash.get(hash)
        if (!operation) {
            throw new Error("Operation not found")
        }
        return operation
    }

    public getOperationsByAddress(
        address: string,
    ): bridge.NativeBridgeOperation[] {
        return this.operations.get(address) || []
    }
}
