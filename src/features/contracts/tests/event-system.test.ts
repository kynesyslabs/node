/**
 * Event system tests
 * Tests contract event emission, storage, and querying capabilities
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { EventManager } from "../events/EventManager"
import { 
    ContractEvent, 
    EventQueryParams,
    ContractEventStats 
} from "../events/EventTypes"
import { 
    handleGetContractEvents,
    handleGetEventsByName,
    handleGetEventsInRange,
    handleGetContractEventStats,
    validateQueryParams
} from "../rpc/ContractEventHandlers"

describe("Event System", () => {
    const mockContractAddress = "a".repeat(64) // 64-char hex address
    const mockContractAddress2 = "b".repeat(64)
    
    const mockEvents: Omit<ContractEvent, 'contractAddress'>[] = [
        {
            name: "Transfer",
            args: { from: "user1", to: "user2", amount: 100 },
            blockHeight: 1000,
            transactionHash: "tx1",
            timestamp: new Date("2023-01-01"),
            eventIndex: 0
        },
        {
            name: "Approval", 
            args: { owner: "user1", spender: "user2", amount: 50 },
            blockHeight: 1001,
            transactionHash: "tx2", 
            timestamp: new Date("2023-01-02"),
            eventIndex: 0
        },
        {
            name: "Transfer",
            args: { from: "user2", to: "user3", amount: 25 },
            blockHeight: 1002,
            transactionHash: "tx3",
            timestamp: new Date("2023-01-03"),
            eventIndex: 0
        }
    ]

    describe("EventManager", () => {
        describe("Event Storage", () => {
            it("should add events to a contract", async () => {
                const result = await EventManager.addEventsToContract(
                    mockContractAddress,
                    mockEvents
                )
                
                expect(result.success).toBe(true)
                expect(result.error).toBeUndefined()
            })
        })

        describe("Event Querying", () => {
            it("should query events for a specific contract", async () => {
                const result = await EventManager.getContractEvents(mockContractAddress, {
                    limit: 10,
                    offset: 0,
                    order: 'desc'
                })

                expect(result.events).toBeArray()
                expect(result.totalCount).toBeGreaterThanOrEqual(0)
                expect(result.hasMore).toBe(false)
                expect(result.pagination).toBeDefined()
                expect(result.pagination.limit).toBe(10)
                expect(result.pagination.offset).toBe(0)
            })

            it("should filter events by name", async () => {
                const result = await EventManager.getContractEvents(mockContractAddress, {
                    eventName: "Transfer",
                    limit: 10
                })

                result.events.forEach(event => {
                    expect(event.name).toBe("Transfer")
                })
            })

            it("should filter events by block range", async () => {
                const result = await EventManager.getContractEvents(mockContractAddress, {
                    fromBlock: 1000,
                    toBlock: 1001,
                    limit: 10
                })

                result.events.forEach(event => {
                    expect(event.blockHeight).toBeGreaterThanOrEqual(1000)
                    expect(event.blockHeight).toBeLessThanOrEqual(1001)
                })
            })

            it("should handle pagination correctly", async () => {
                const firstPage = await EventManager.getContractEvents(mockContractAddress, {
                    limit: 1,
                    offset: 0
                })

                const secondPage = await EventManager.getContractEvents(mockContractAddress, {
                    limit: 1,
                    offset: 1
                })

                expect(firstPage.events.length).toBeLessThanOrEqual(1)
                expect(secondPage.events.length).toBeLessThanOrEqual(1)
                
                if (firstPage.events.length > 0 && secondPage.events.length > 0) {
                    expect(firstPage.events[0].eventIndex).not.toBe(secondPage.events[0].eventIndex)
                }
            })
        })

        describe("Cross-Contract Event Queries", () => {
            it("should query events by name across all contracts", async () => {
                const result = await EventManager.getEventsByName("Transfer", {
                    limit: 10,
                    order: 'desc'
                })

                expect(result.events).toBeArray()
                result.events.forEach(event => {
                    expect(event.name).toBe("Transfer")
                })
            })

            it("should query events in block range across all contracts", async () => {
                const result = await EventManager.getEventsInRange(1000, 1002, {
                    limit: 10
                })

                expect(result.events).toBeArray()
                result.events.forEach(event => {
                    expect(event.blockHeight).toBeGreaterThanOrEqual(1000)
                    expect(event.blockHeight).toBeLessThanOrEqual(1002)
                })
            })
        })

        describe("Event Statistics", () => {
            it("should get contract event statistics", async () => {
                const stats = await EventManager.getContractEventStats(mockContractAddress)

                if (stats) {
                    expect(stats.contractAddress).toBe(mockContractAddress)
                    expect(stats.totalEvents).toBeGreaterThanOrEqual(0)
                    expect(stats.eventTypes).toBeGreaterThanOrEqual(0)
                    expect(stats.eventCountsByName).toBeObject()
                }
            })

            it("should return null for non-existent contract", async () => {
                const nonExistentAddress = "9".repeat(64)
                const stats = await EventManager.getContractEventStats(nonExistentAddress)
                expect(stats).toBeNull()
            })
        })
    })

    describe("RPC Event Handlers", () => {
        describe("handleGetContractEvents", () => {
            it("should handle valid contract address", async () => {
                const result = await handleGetContractEvents({
                    contractAddress: mockContractAddress,
                    queryParams: { limit: 5 }
                })

                expect(result.success).toBe(true)
                expect(result.data).toBeDefined()
                expect(result.error).toBeUndefined()
            })

            it("should reject invalid contract address", async () => {
                const result = await handleGetContractEvents({
                    contractAddress: "invalid_address"
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("Invalid contract address format")
            })

            it("should reject missing contract address", async () => {
                const result = await handleGetContractEvents({
                    contractAddress: ""
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("Contract address is required")
            })
        })

        describe("handleGetEventsByName", () => {
            it("should handle valid event name", async () => {
                const result = await handleGetEventsByName({
                    eventName: "Transfer",
                    queryParams: { limit: 5 }
                })

                expect(result.success).toBe(true)
                expect(result.data).toBeDefined()
            })

            it("should reject invalid event name format", async () => {
                const result = await handleGetEventsByName({
                    eventName: "123InvalidName"
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("Invalid event name format")
            })

            it("should reject missing event name", async () => {
                const result = await handleGetEventsByName({
                    eventName: ""
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("Event name is required")
            })
        })

        describe("handleGetEventsInRange", () => {
            it("should handle valid block range", async () => {
                const result = await handleGetEventsInRange({
                    fromBlock: 1000,
                    toBlock: 1010,
                    queryParams: { limit: 5 }
                })

                expect(result.success).toBe(true)
                expect(result.data).toBeDefined()
            })

            it("should reject invalid block range", async () => {
                const result = await handleGetEventsInRange({
                    fromBlock: 1010,
                    toBlock: 1000
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("fromBlock must be less than or equal to toBlock")
            })

            it("should reject too large block range", async () => {
                const result = await handleGetEventsInRange({
                    fromBlock: 1000,
                    toBlock: 12000 // 11,000 block range > 10,000 limit
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("Block range too large")
            })

            it("should reject negative block numbers", async () => {
                const result = await handleGetEventsInRange({
                    fromBlock: -1,
                    toBlock: 1000
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("Block numbers must be non-negative")
            })
        })

        describe("handleGetContractEventStats", () => {
            it("should handle valid contract address", async () => {
                const result = await handleGetContractEventStats({
                    contractAddress: mockContractAddress
                })

                // Result can be success with data or failure if contract not found
                expect(result.success).toBeBoolean()
                if (result.success) {
                    expect(result.data).toBeDefined()
                    expect(result.data.contractAddress).toBe(mockContractAddress)
                }
            })

            it("should reject invalid contract address", async () => {
                const result = await handleGetContractEventStats({
                    contractAddress: "invalid"
                })

                expect(result.success).toBe(false)
                expect(result.error).toContain("Invalid contract address format")
            })
        })
    })

    describe("Query Parameter Validation", () => {
        it("should validate correct query parameters", () => {
            const result = validateQueryParams({
                limit: 50,
                offset: 0,
                order: 'desc',
                fromBlock: 1000,
                toBlock: 2000
            })

            expect(result.valid).toBe(true)
            expect(result.error).toBeUndefined()
        })

        it("should reject invalid limit", () => {
            const result = validateQueryParams({
                limit: 1500 // > 1000 max
            })

            expect(result.valid).toBe(false)
            expect(result.error).toContain("Limit must be an integer between 1 and 1000")
        })

        it("should reject invalid offset", () => {
            const result = validateQueryParams({
                offset: -1
            })

            expect(result.valid).toBe(false)
            expect(result.error).toContain("Offset must be a non-negative integer")
        })

        it("should reject invalid order", () => {
            const result = validateQueryParams({
                order: 'invalid'
            })

            expect(result.valid).toBe(false)
            expect(result.error).toContain("Order must be 'asc' or 'desc'")
        })

        it("should reject invalid block numbers", () => {
            const result = validateQueryParams({
                fromBlock: -5
            })

            expect(result.valid).toBe(false)
            expect(result.error).toContain("fromBlock must be a non-negative integer")
        })
    })

    describe("Event Data Validation", () => {
        it("should handle events with various data types", async () => {
            const complexEvents: Omit<ContractEvent, 'contractAddress'>[] = [
                {
                    name: "ComplexEvent",
                    args: {
                        number: 42,
                        string: "test",
                        boolean: true,
                        array: [1, 2, 3],
                        object: { nested: "value" },
                        bigNumber: "1000000000000000000"
                    },
                    blockHeight: 2000,
                    transactionHash: "complex_tx",
                    timestamp: new Date(),
                    eventIndex: 0
                }
            ]

            const result = await EventManager.addEventsToContract(
                mockContractAddress,
                complexEvents
            )

            expect(result.success).toBe(true)
        })
    })

    describe("Event Ordering", () => {
        it("should return events in descending order by default", async () => {
            const result = await EventManager.getContractEvents(mockContractAddress, {
                limit: 10
            })

            if (result.events.length > 1) {
                for (let i = 0; i < result.events.length - 1; i++) {
                    expect(result.events[i].blockHeight)
                        .toBeGreaterThanOrEqual(result.events[i + 1].blockHeight)
                }
            }
        })

        it("should return events in ascending order when specified", async () => {
            const result = await EventManager.getContractEvents(mockContractAddress, {
                limit: 10,
                order: 'asc'
            })

            if (result.events.length > 1) {
                for (let i = 0; i < result.events.length - 1; i++) {
                    expect(result.events[i].blockHeight)
                        .toBeLessThanOrEqual(result.events[i + 1].blockHeight)
                }
            }
        })
    })
})