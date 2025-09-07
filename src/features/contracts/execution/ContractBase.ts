/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Base class for all Demos smart contracts
 * Provides execution context and utility methods to contract implementations
 */

import type { ExecutionContext, CallCounter } from "./ExecutionContext"

export abstract class DemosContract {
    // Injected context (set by sandbox before execution)
    protected _context?: ExecutionContext
    protected _callCounter?: CallCounter
    protected _state?: Record<string, any>
    protected _events: Array<{
        name: string
        args: Record<string, any>
        timestamp: Date
    }> = []

    /**
     * Initialize contract with execution context
     * Called by the sandbox before method execution
     */
    _initialize(
        context: ExecutionContext,
        callCounter: CallCounter,
        state: Record<string, any>,
    ) {
        this._context = context
        this._callCounter = callCounter
        this._state = state || {}
    }

    /**
     * Get the sender of the current transaction
     */
    protected get sender(): string {
        if (!this._context) {
            throw new Error("Contract not initialized - context not available")
        }
        return this._context.sender
    }

    /**
     * Get the contract's own address
     */
    protected get address(): string {
        if (!this._context) {
            throw new Error("Contract not initialized - context not available")
        }
        return this._context.contractAddress
    }

    /**
     * Get the current block height
     */
    protected get blockHeight(): number {
        if (!this._context) {
            throw new Error("Contract not initialized - context not available")
        }
        return this._context.blockHeight
    }

    /**
     * Get the DEM value sent with this call
     */
    protected get value(): bigint {
        if (!this._context) {
            throw new Error("Contract not initialized - context not available")
        }
        return this._context.value
    }

    /**
     * Get a value from contract storage
     */
    protected getState<T = any>(key: string): T | undefined {
        if (!this._state) {
            throw new Error("Contract not initialized - state not available")
        }
        return this._state[key] as T
    }

    /**
     * Set a value in contract storage
     */
    protected setState(key: string, value: any): void {
        if (!this._state) {
            throw new Error("Contract not initialized - state not available")
        }
        this._state[key] = value
    }

    /**
     * Emit an event
     */
    protected emit(eventName: string, args: Record<string, any> = {}): void {
        this._events.push({
            name: eventName,
            args,
            timestamp: new Date(),
        })
    }

    /**
     * Get all events emitted during execution
     * Used by sandbox to collect events
     */
    _getEvents(): Array<{
        name: string
        args: Record<string, any>
        timestamp: Date
    }> {
        return this._events
    }

    /**
     * Get current state changes
     * Used by sandbox to collect state updates
     */
    _getStateChanges(): Record<string, any> {
        return this._state || {}
    }

    /**
     * Constructor - subclasses should call super(context)
     * Will be called during contract deployment
     */
    constructor(context: ExecutionContext) {
        this._context = context
    }
}
