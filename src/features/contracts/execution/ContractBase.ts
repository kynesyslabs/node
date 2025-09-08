/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Base class for all Demos Network smart contracts
 * Provides state management, event emission, and execution context access
 */

import type { ExecutionContext } from "./ExecutionContext"

export interface ContractEvent {
    name: string
    args: Record<string, any>
    blockHeight: number
    timestamp: Date
    txHash?: string
}

export abstract class DemosContract {
    // Execution context injected by sandbox
    protected context!: ExecutionContext

    // Original state from database
    private _originalState: Record<string, any> = {}

    // Tracked state changes during execution
    private _stateChanges: Record<string, any> = {}

    // Events emitted during execution
    private _events: ContractEvent[] = []

    // Call counter for nested calls
    private _callCount = 0

    /**
     * Initialize contract with context and state
     * Called by sandbox before method execution
     */
    public __initialize(
        context: ExecutionContext,
        state: Record<string, any>,
    ): void {
        this.context = context
        this._originalState = state || {}
        this._stateChanges = {}
        this._events = []
        this._callCount = 0
    }

    /**
     * State management interface
     */
    protected state = {
        /**
         * Get a value from contract state
         * Checks pending changes first, then original state
         */
        get: <T = any>(key: string): T | undefined => {
            // Check pending changes first
            if (key in this._stateChanges) {
                return this._stateChanges[key] as T
            }
            // Fall back to original state
            return this._originalState[key] as T
        },

        /**
         * Set a value in contract state
         * Changes are buffered until execution completes
         */
        set: (key: string, value: any): void => {
            if (value === undefined) {
                // Setting undefined means deletion
                this._stateChanges[key] = null
            } else {
                this._stateChanges[key] = value
            }
        },

        /**
         * Delete a key from contract state
         */
        delete: (key: string): void => {
            this._stateChanges[key] = null
        },

        /**
         * Check if a key exists in state
         */
        has: (key: string): boolean => {
            if (key in this._stateChanges) {
                return this._stateChanges[key] !== null
            }
            return key in this._originalState
        },

        /**
         * Get all keys in state
         */
        keys: (): string[] => {
            const keys = new Set<string>()

            // Add original keys
            Object.keys(this._originalState).forEach(key => keys.add(key))

            // Add/remove based on changes
            Object.entries(this._stateChanges).forEach(([key, value]) => {
                if (value === null) {
                    keys.delete(key)
                } else {
                    keys.add(key)
                }
            })

            return Array.from(keys)
        },
    }

    /**
     * Emit an event during contract execution
     */
    protected emit(name: string, args: Record<string, any>): void {
        this._events.push({
            name,
            args,
            blockHeight: this.context.blockHeight,
            timestamp: this.context.timestamp,
        })
    }

    /**
     * Access control helpers
     */

    /**
     * Require that the sender matches a specific address
     */
    protected requireSender(
        address: string,
        message = "Unauthorized sender",
    ): void {
        if (this.context.sender !== address) {
            throw new Error(message)
        }
    }

    /**
     * Require that a condition is true
     */
    protected require(
        condition: boolean,
        message = "Requirement failed",
    ): void {
        if (!condition) {
            throw new Error(message)
        }
    }

    /**
     * Revert execution with an error message
     */
    protected revert(message: string): never {
        throw new Error(`Execution reverted: ${message}`)
    }

    /**
     * Utility methods
     */

    /**
     * Get the current block height
     */
    protected get blockHeight(): number {
        return this.context.blockHeight
    }

    /**
     * Get the current timestamp
     */
    protected get timestamp(): Date {
        return this.context.timestamp
    }

    /**
     * Get the message sender address
     */
    protected get sender(): string {
        return this.context.sender
    }

    /**
     * Get the contract's own address
     */
    protected get address(): string {
        return this.context.contractAddress
    }

    /**
     * Get the value sent with the transaction
     */
    protected get value(): bigint {
        return this.context.value
    }

    /**
     * Internal methods for sandbox use
     */

    /**
     * Increment call counter (used by proxy)
     */
    public __incrementCallCount(): void {
        this._callCount++
    }

    /**
     * Get current call count
     */
    public __getCallCount(): number {
        return this._callCount
    }

    /**
     * Get state changes for persistence
     */
    public __getStateChanges(): Record<string, any> {
        return this._stateChanges
    }

    /**
     * Get emitted events
     */
    public __getEvents(): ContractEvent[] {
        return this._events
    }

    /**
     * Required constructor for all contracts
     */
    constructor() {
        // Context and state will be injected via __initialize
    }
}
