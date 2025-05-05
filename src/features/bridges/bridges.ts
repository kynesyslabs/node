// !SECTION Bridges interface that will be imported from the sdk once pushed
// TODO This interface defines a bridge on a chain (e.g. a controlled bridge for a specific shard on a specific chain)
export interface BridgeContext {
    // TODO Implement the context
    chain: string // ? Should we have an enum for the chains? In general, not only for this interface
    address: string // ? Better types using the chain enum for a public key?
    controllers_properties: {
        seed: string // Seed (CVSA) of the controllers
        reference_block: number // Block number of the reference block forged by the controllers (used to check if the bridge is valid)
    }
    valid_from: number // Block number of the block from which the bridge is valid
    valid_to: number // Block number of the block until which the bridge is valid
}

// TODO This interface defines a bridge operation in a specific context
export interface BridgeOperation {
    id: string // Operation ID (should be the same as the one in the block and is the hash of the operation content)
    content: {
        context: BridgeContext // Exposes the chain, address and controllers properties of the bridge used to perform the operation
        from: string // ? Better types using the chain enum for a public key?
        to: string // ? Better types using the chain enum for a public key?
        currency: string // ? Enum here too?
        amount: number
        max_block_delay: number // Number of blocks before funds are released if the operation is not confirmed
    }
}

// ! END SECTION

export interface BridgeOperationResult {
    success: boolean
    message: string
    operation: BridgeOperation
    extra: any
}

/**
 * A Bridge instance contains a map of operations indexed by the operation id
 * Each bridge has its own context and operations, and is responsible for executing and registering operations
 * within its own context and validity period
 */
class Bridge {
    // Multiton class for the bridge
    private static instances: Map<string, Bridge> = new Map() // Existing bridges indexed by the id, for quick access

    // Instance properties
    public id: string
    public context: BridgeContext
    public operations: Map<string, BridgeOperation> = new Map() // Map of operations indexed by the operation id

    private constructor(context: BridgeContext) {
        this.context = context // Setting the context
        this.id = context.address + "_" + context.chain // Setting the id
        Bridge.instances.set(this.id, this) // Registering the bridge instance
    }

    /**
     * Gets an instance of the bridge
     * @param id - The id of the bridge
     * @returns The bridge instance or null if it does not exist
     */
    public static getInstance(id: string): Bridge {
        if (!Bridge.instances.has(id)) {
            return null // Bridge not found
        }
        return Bridge.instances.get(id)
    }

    /**
     * Executes an operation on the bridge
     * @param operationId - The id of the operation to execute
     * @returns The result of the operation
     */
    async executeOperation(operationId: string): Promise<BridgeOperationResult> {
        const result: BridgeOperationResult = {
            success: false,
            message: "",
            operation: null,
            extra: null,
        }
        // See if we have the operation in the operations map
        if (!this.operations.has(operationId)) {
            result.message = "Operation not found"
            return result
        }
        // TODO Implement the logic to execute the operation
    }

    /**
     * Registers an operation on the bridge
     * @param operation - The operation to register
     * @returns True if the operation was registered, false otherwise
     */
    async registerOperation(operation: BridgeOperation): Promise<boolean> {
        const result = false
        // TODO Implement the logic to register the operation
        return result
    }
}

/**
 * This class contains static methods to control the bridges easily
 */
class BridgesControls {
    // TODO Implement the controls like getting the shard from the CVSA in the block and so on
    static getShardFromCVSA(cvsa: string): string[] {
        // Returns the shard as an array of public keys
        // TODO Implement the logic to get the shard from the CVSA
        return []
    }
}

export { Bridge, BridgesControls }
