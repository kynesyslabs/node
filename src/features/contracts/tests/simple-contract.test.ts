/* eslint-disable @typescript-eslint/no-extra-semi */
/* eslint-disable no-extra-semi */
/**
 * Simple contract tests without Worker sandboxing
 * Tests contract base class functionality directly
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { DemosContract } from "../execution/ContractBase"
import { createExecutionContext } from "../execution/ExecutionContext"
import { MAX_CONTRACT_SIZE } from "../validation/ContractValidator"

// Simple test contract that extends DemosContract
class TestContract extends DemosContract {
    public setValue(key: string, value: any): void {
        this.require(key && key.length > 0, "Key cannot be empty")

        const oldValue = this.state.get(key)
        this.state.set(key, value)

        this.emit("ValueChanged", {
            key,
            oldValue,
            newValue: value,
            changedBy: this.sender,
        })
    }

    public getValue(key: string): any {
        return this.state.get(key)
    }

    public getInfo(): object {
        return {
            name: "TestContract",
            address: this.address,
            blockHeight: this.blockHeight,
            sender: this.sender,
            keyCount: this.state.keys().length,
        }
    }

    public requireTest(condition: boolean): void {
        this.require(condition, "Test condition failed")
    }

    public revertTest(): void {
        this.revert("Test revert")
    }
}

describe("Contract Base Class Tests", () => {
    let contract: TestContract

    beforeEach(() => {
        contract = new TestContract()

        const context = createExecutionContext({
            sender: "test-sender",
            contractAddress: "test-contract",
            blockHeight: 100,
            value: 0n,
        })

        contract.__initialize(context, {})
    })

    describe("State Management", () => {
        it("should set and get values", () => {
            contract.setValue("testKey", "testValue")

            expect(contract.getValue("testKey")).toBe("testValue")
        })

        it("should track state changes", () => {
            contract.setValue("key1", "value1")
            contract.setValue("key2", "value2")

            const stateChanges = contract.__getStateChanges()
            expect(stateChanges).toEqual({
                key1: "value1",
                key2: "value2",
            })
        })

        it("should handle state deletion", () => {
            contract.setValue("deleteMe", "value")
            expect(contract.getValue("deleteMe")).toBe("value")

            // Manually delete using state interface
            ;(contract as any).state.delete("deleteMe")
            expect(contract.getValue("deleteMe")).toBe(null)

            const stateChanges = contract.__getStateChanges()
            expect(stateChanges.deleteMe).toBe(null)
        })

        it("should check if keys exist", () => {
            contract.setValue("existsKey", "value")

            expect((contract as any).state.has("existsKey")).toBe(true)
            expect((contract as any).state.has("nonExistentKey")).toBe(false)
        })

        it("should list all keys", () => {
            contract.setValue("key1", "value1")
            contract.setValue("key2", "value2")

            const keys = (contract as any).state.keys()
            expect(keys).toContain("key1")
            expect(keys).toContain("key2")
            expect(keys).toHaveLength(2)
        })
    })

    describe("Event Emission", () => {
        it("should emit events with metadata", () => {
            contract.setValue("eventKey", "eventValue")

            const events = contract.__getEvents()
            expect(events).toHaveLength(1)
            expect(events[0]).toEqual({
                name: "ValueChanged",
                args: {
                    key: "eventKey",
                    oldValue: undefined,
                    newValue: "eventValue",
                    changedBy: "test-sender",
                },
                blockHeight: 100,
                timestamp: expect.any(Date),
            })
        })

        it("should track multiple events", () => {
            contract.setValue("key1", "value1")
            contract.setValue("key2", "value2")

            const events = contract.__getEvents()
            expect(events).toHaveLength(2)
            expect(events[0].args.key).toBe("key1")
            expect(events[1].args.key).toBe("key2")
        })
    })

    describe("Context Access", () => {
        it("should provide execution context", () => {
            const info = contract.getInfo()

            expect(info).toEqual({
                name: "TestContract",
                address: "test-contract",
                blockHeight: 100,
                sender: "test-sender",
                keyCount: 0,
            })
        })

        it("should provide context getters", () => {
            expect((contract as any).sender).toBe("test-sender")
            expect((contract as any).address).toBe("test-contract")
            expect((contract as any).blockHeight).toBe(100)
            expect((contract as any).timestamp).toBeInstanceOf(Date)
            expect((contract as any).value).toBe(0n)
        })
    })

    describe("Validation Helpers", () => {
        it("should handle require conditions", () => {
            // Should not throw
            contract.requireTest(true)

            // Should throw
            expect(() => contract.requireTest(false)).toThrow(
                "Test condition failed",
            )
        })

        it("should handle revert", () => {
            expect(() => contract.revertTest()).toThrow(
                "Execution reverted: Test revert",
            )
        })

        it("should enforce empty key validation", () => {
            expect(() => contract.setValue("", "value")).toThrow(
                "Key cannot be empty",
            )
        })

        it("should handle sender requirements", () => {
            // Should not throw (same sender)
            ;(contract as any).requireSender("test-sender")

            // Should throw (different sender)
            expect(() =>
                (contract as any).requireSender("different-sender"),
            ).toThrow("Unauthorized sender")
        })
    })

    describe("Call Counting", () => {
        it("should track call count", () => {
            contract.setValue("key1", "value1")

            // The call count should be incremented by the proxy
            // But in direct testing without proxy, it stays 0
            const callCount = contract.__getCallCount()
            expect(callCount).toBe(0)

            // Manually increment to test functionality
            contract.__incrementCallCount()
            contract.__incrementCallCount()
            expect(contract.__getCallCount()).toBe(2)
        })
    })
})

describe("Contract Source Validation", () => {
    it("should validate SimpleStorageContract source", () => {
        const contractPath = join(
            __dirname,
            "../examples/SimpleStorageContract.ts",
        )
        const contractSource = readFileSync(contractPath, "utf-8")

        expect(contractSource).toBeDefined()
        expect(contractSource.length).toBeGreaterThan(0)
        expect(contractSource.length).toBeLessThan(MAX_CONTRACT_SIZE)
        expect(contractSource).toContain("extends DemosContract")
        expect(contractSource).toContain("SimpleStorageContract")
        expect(contractSource).toContain("setValue")
        expect(contractSource).toContain("getValue")
    })

    it("should detect contract structure", () => {
        const contractPath = join(
            __dirname,
            "../examples/SimpleStorageContract.ts",
        )
        const contractSource = readFileSync(contractPath, "utf-8")

        // Check for required methods
        expect(contractSource).toContain("public setValue")
        expect(contractSource).toContain("public getValue")
        expect(contractSource).toContain("this.state.set")
        expect(contractSource).toContain("this.state.get")
        expect(contractSource).toContain("this.emit")
        expect(contractSource).toContain("this.require")
    })
})
