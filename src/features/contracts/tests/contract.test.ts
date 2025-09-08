/**
 * Test suite for Demos Network smart contracts
 * Tests contract compilation, execution, state management, and events
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { Sandbox } from "../execution/Sandbox"
import { MAX_CONTRACT_SIZE } from "../validation/ContractValidator"
import { createExecutionContext } from "../execution/ExecutionContext"
import type { ExecutionResult } from "../execution/ExecutionContext"

describe("Smart Contract System", () => {
    let contractSource: string
    let sandbox: Sandbox

    beforeEach(() => {
        // Read the example contract
        const contractPath = join(
            __dirname,
            "../examples/SimpleStorageContract.ts",
        )
        contractSource = readFileSync(contractPath, "utf-8")

        // Create a new sandbox for each test
        sandbox = new Sandbox()
    })

    describe("Contract Validation", () => {
        it("should validate contract source exists", () => {
            expect(contractSource).toBeDefined()
            expect(contractSource.length).toBeGreaterThan(0)
            expect(contractSource).toContain("DemosContract")
            expect(contractSource).toContain("SimpleStorageContract")
        })

        it("should check contract extends DemosContract", () => {
            const hasBaseClass = contractSource.includes(
                "extends DemosContract",
            )
            expect(hasBaseClass).toBe(true)
        })

        it("should validate contract size limits", () => {
            expect(contractSource.length).toBeLessThan(MAX_CONTRACT_SIZE)
        })
    })

    describe("Contract Execution", () => {
        it("should execute a simple method", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
                value: 0n,
            })

            const result = await sandbox.execute({
                contractSource,
                methodName: "setValue",
                arguments: ["testKey", "testValue"],
                executionContext: context,
                contractState: {},
            })

            expect(result.success).toBe(true)
            expect(result.stateChanges).toEqual({
                testKey: "testValue",
            })
            expect(result.callCount).toBeGreaterThan(0)
        })

        it("should handle method that does not exist", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            const result = await sandbox.execute({
                contractSource,
                methodName: "nonExistentMethod",
                arguments: [],
                executionContext: context,
                contractState: {},
            })

            expect(result.success).toBe(false)
            expect(result.error).toContain("not found")
        })

        it("should enforce require conditions", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            // Try to set empty key (should fail)
            const result = await sandbox.execute({
                contractSource,
                methodName: "setValue",
                arguments: ["", "testValue"],
                executionContext: context,
                contractState: {},
            })

            expect(result.success).toBe(false)
            expect(result.error).toContain("Key cannot be empty")
        })

        it("should handle execution timeout", async () => {
            const infiniteLoopContract = `
                import { DemosContract } from '../execution/ContractBase'
                
                export class InfiniteContract extends DemosContract {
                    public infinite() {
                        while(true) {
                            // Infinite loop
                        }
                    }
                }
            `

            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            const result = await sandbox.execute({
                contractSource: infiniteLoopContract,
                methodName: "infinite",
                arguments: [],
                executionContext: context,
                contractState: {},
            })

            expect(result.success).toBe(false)
            expect(result.error).toContain("timeout")
        })
    })

    describe("State Management", () => {
        it("should persist state changes", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            // Set a value
            const result1 = await sandbox.execute({
                contractSource,
                methodName: "setValue",
                arguments: ["key1", "value1"],
                executionContext: context,
                contractState: {},
            })

            expect(result1.success).toBe(true)
            expect(result1.stateChanges).toEqual({ key1: "value1" })

            // Get the value with updated state
            const result2 = await sandbox.execute({
                contractSource,
                methodName: "getValue",
                arguments: ["key1"],
                executionContext: context,
                contractState: result1.stateChanges,
            })

            expect(result2.success).toBe(true)
            expect(result2.returnValue).toBe("value1")
        })

        it("should handle state deletion", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            // Set a protected value
            const result1 = await sandbox.execute({
                contractSource,
                methodName: "setProtectedValue",
                arguments: ["protectedKey", "protectedValue"],
                executionContext: context,
                contractState: {},
            })

            expect(result1.success).toBe(true)
            expect(result1.stateChanges).toEqual({
                protectedKey: "protectedValue",
                setter_protectedKey: "user123",
            })

            // Delete the value (should succeed as same sender)
            const result2 = await sandbox.execute({
                contractSource,
                methodName: "deleteValue",
                arguments: ["protectedKey"],
                executionContext: context,
                contractState: result1.stateChanges,
            })

            expect(result2.success).toBe(true)
            expect(result2.stateChanges).toEqual({
                protectedKey: null,
                setter_protectedKey: null,
            })
        })

        it("should enforce access control", async () => {
            const context1 = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            // Set a protected value
            const result1 = await sandbox.execute({
                contractSource,
                methodName: "setProtectedValue",
                arguments: ["protectedKey", "protectedValue"],
                executionContext: context1,
                contractState: {},
            })

            expect(result1.success).toBe(true)

            // Try to delete with different sender
            const context2 = createExecutionContext({
                sender: "attacker",
                contractAddress: "contract456",
                blockHeight: 1001,
            })

            const result2 = await sandbox.execute({
                contractSource,
                methodName: "deleteValue",
                arguments: ["protectedKey"],
                executionContext: context2,
                contractState: result1.stateChanges,
            })

            expect(result2.success).toBe(false)
            expect(result2.error).toContain("Only the original setter")
        })
    })

    describe("Event Emission", () => {
        it("should emit events with metadata", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            const result = await sandbox.execute({
                contractSource,
                methodName: "setValue",
                arguments: ["eventKey", "eventValue"],
                executionContext: context,
                contractState: {},
            })

            expect(result.success).toBe(true)
            expect(result.events).toHaveLength(1)
            expect(result.events[0]).toEqual({
                name: "ValueChanged",
                args: {
                    key: "eventKey",
                    oldValue: undefined,
                    newValue: "eventValue",
                    changedBy: "user123",
                },
                blockHeight: 1000,
                timestamp: expect.any(Date),
            })
        })

        it("should emit multiple events in complex operations", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            const result = await sandbox.execute({
                contractSource,
                methodName: "complexOperation",
                arguments: [
                    ["key1", "key2", "key3"],
                    ["value1", "value2", "value3"],
                ],
                executionContext: context,
                contractState: {},
            })

            expect(result.success).toBe(true)
            // Should emit 3 ValueChanged events + 1 ComplexOperationComplete event
            expect(result.events.length).toBeGreaterThanOrEqual(4)

            const lastEvent = result.events[result.events.length - 1]
            expect(lastEvent.name).toBe("ComplexOperationComplete")
            expect(lastEvent.args.keysUpdated).toBe(3)
        })
    })

    describe("Fee Calculation", () => {
        it("should count method calls for fee calculation", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            // Simple method call
            const result1 = await sandbox.execute({
                contractSource,
                methodName: "getValue",
                arguments: ["key1"],
                executionContext: context,
                contractState: {},
            })

            expect(result1.success).toBe(true)
            expect(result1.callCount).toBe(1) // Single method call

            // Complex operation with nested calls
            const result2 = await sandbox.execute({
                contractSource,
                methodName: "complexOperation",
                arguments: [
                    ["key1", "key2"],
                    ["value1", "value2"],
                ],
                executionContext: context,
                contractState: {},
            })

            expect(result2.success).toBe(true)
            expect(result2.callCount).toBeGreaterThan(1) // Multiple nested calls
            expect(result2.gasUsed).toBeGreaterThan(result1.gasUsed) // More gas for more calls
        })

        it("should calculate gas based on call count", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            const result = await sandbox.execute({
                contractSource,
                methodName: "setValue",
                arguments: ["key1", "value1"],
                executionContext: context,
                contractState: {},
            })

            expect(result.success).toBe(true)

            const baseFee = 1000000000000000000n // 1 DEM in wei
            const expectedGas = baseFee + BigInt(result.callCount) * baseFee
            expect(result.gasUsed).toBe(expectedGas)
        })
    })

    describe("Contract Info", () => {
        it("should return contract information", async () => {
            const context = createExecutionContext({
                sender: "user123",
                contractAddress: "contract456",
                blockHeight: 1000,
            })

            const result = await sandbox.execute({
                contractSource,
                methodName: "getInfo",
                arguments: [],
                executionContext: context,
                contractState: {
                    key1: "value1",
                    key2: "value2",
                },
            })

            expect(result.success).toBe(true)
            expect(result.returnValue).toEqual({
                name: "SimpleStorageContract",
                version: "1.0.0",
                address: "contract456",
                blockHeight: 1000,
                timestamp: expect.any(Date),
                keyCount: 2,
            })
        })
    })

    // Cleanup
    afterEach(() => {
        // Sandbox cleanup happens automatically when worker completes
        sandbox = null as any
    })
})
