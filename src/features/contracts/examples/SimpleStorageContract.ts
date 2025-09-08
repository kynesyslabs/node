/**
 * Example smart contract demonstrating DemosContract usage
 * Simple storage contract with getter/setter and events
 */

import { DemosContract } from "../execution/ContractBase"

export class SimpleStorageContract extends DemosContract {
    /**
     * Store a value with an associated key
     */
    public setValue(key: string, value: any): void {
        // Validate inputs
        this.require(key && key.length > 0, "Key cannot be empty")
        this.require(key.length <= 100, "Key too long (max 100 chars)")

        // Get old value for event
        const oldValue = this.state.get(key)

        // Update state
        this.state.set(key, value)

        // Emit event
        this.emit("ValueChanged", {
            key,
            oldValue,
            newValue: value,
            changedBy: this.sender,
        })
    }

    /**
     * Get a value by key
     */
    public getValue(key: string): any {
        return this.state.get(key)
    }

    /**
     * Delete a value
     */
    public deleteValue(key: string): void {
        // Only the original setter can delete
        const setter = this.state.get(`setter_${key}`)
        if (setter) {
            this.requireSender(
                setter,
                "Only the original setter can delete this value",
            )
        }

        const oldValue = this.state.get(key)
        this.state.delete(key)
        this.state.delete(`setter_${key}`)

        this.emit("ValueDeleted", {
            key,
            oldValue,
            deletedBy: this.sender,
        })
    }

    /**
     * Set a value that only the sender can modify
     */
    public setProtectedValue(key: string, value: any): void {
        const existingSetter = this.state.get(`setter_${key}`)

        if (existingSetter) {
            this.requireSender(
                existingSetter,
                "Only the original setter can modify this value",
            )
        }

        this.state.set(key, value)
        this.state.set(`setter_${key}`, this.sender)

        this.emit("ProtectedValueSet", {
            key,
            value,
            setter: this.sender,
        })
    }

    /**
     * Get all stored keys
     */
    public getKeys(): string[] {
        return this.state.keys().filter(k => !k.startsWith("setter_")) // Filter out metadata keys
    }

    /**
     * Get contract info
     */
    public getInfo(): object {
        return {
            name: "SimpleStorageContract",
            version: "1.0.0",
            address: this.address,
            blockHeight: this.blockHeight,
            timestamp: this.timestamp,
            keyCount: this.getKeys().length,
        }
    }

    /**
     * Example of a method that makes nested calls (for fee testing)
     */
    public complexOperation(keys: string[], values: any[]): void {
        this.require(
            keys.length === values.length,
            "Keys and values must have same length",
        )

        // This will make multiple internal calls, increasing the fee
        for (let i = 0; i < keys.length; i++) {
            this.setValue(keys[i], values[i]) // Each call adds to the fee
        }

        // Call another method
        const totalKeys = this.getKeys() // Another call for fee

        this.emit("ComplexOperationComplete", {
            keysUpdated: keys.length,
            totalKeys: totalKeys.length,
        })
    }
}
