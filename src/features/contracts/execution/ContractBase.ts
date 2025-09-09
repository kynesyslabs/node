/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Base class for all Demos Network smart contracts
 * Provides state management, event emission, and execution context access
 */

import type { ExecutionContext } from "./ExecutionContext"
import type { ContractEvent } from "../events/EventTypes"

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
        // Validate event name
        if (!name || typeof name !== "string") {
            throw new Error("Event name must be a non-empty string")
        }

        // Validate event name format (alphanumeric + underscore, starts with letter)
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
            throw new Error(
                "Event name must start with a letter and contain only alphanumeric characters and underscores",
            )
        }

        // Validate event args
        if (args && typeof args !== "object") {
            throw new Error("Event args must be an object")
        }

        // Check event args size (limit to 10KB per event)
        const eventArgsSize = JSON.stringify(args || {}).length
        if (eventArgsSize > 10240) {
            throw new Error("Event args too large (maximum 10KB per event)")
        }

        // Create event with enhanced metadata
        const event = {
            name,
            args: args || {},
            contractAddress: this.context.contractAddress,
            blockHeight: this.context.blockHeight,
            transactionHash: "", // Will be set by the transaction handler
            timestamp: new Date(this.context.timestamp),
            eventIndex: this._events.length, // Index within this execution
        }

        this._events.push(event)

        // Limit total events per execution (prevent spam)
        if (this._events.length > 100) {
            throw new Error(
                "Too many events emitted in single execution (maximum 100)",
            )
        }
    }

    /**
     * Get all events emitted during this execution
     */
    public getEmittedEvents() {
        return [...this._events] // Return copy to prevent modification
    }

    /**
     * Check if an event with specific name was emitted
     */
    protected hasEmittedEvent(eventName: string): boolean {
        return this._events.some(event => event.name === eventName)
    }

    /**
     * Get events by name emitted during this execution
     */
    protected getEventsByName(eventName: string) {
        return this._events.filter(event => event.name === eventName)
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
