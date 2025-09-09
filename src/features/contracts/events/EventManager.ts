/**
 * Event Manager for smart contract event storage and querying
 */

import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import {
    ContractEvent,
    EventQueryParams,
    EventQueryResponse,
    ContractEventStats,
    EventFilter,
    BatchEventQuery,
} from "./EventTypes"

export class EventManager {
    /**
     * Query events from a specific contract
     */
    static async getContractEvents(
        contractAddress: string,
        params: Omit<EventQueryParams, "contractAddress"> = {},
    ): Promise<EventQueryResponse> {
        try {
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            // Get contract
            const contract = await gcrRepo.findOne({
                where: { pubkey: contractAddress },
            })

            if (!contract || !contract.contract) {
                return {
                    events: [],
                    totalCount: 0,
                    hasMore: false,
                    pagination: {
                        limit: params.limit || 50,
                        offset: params.offset || 0,
                        currentPage:
                            Math.floor(
                                (params.offset || 0) / (params.limit || 50),
                            ) + 1,
                        totalPages: 0,
                    },
                }
            }

            // Filter events based on parameters
            let events = contract.contract.events || []

            // Filter by event name
            if (params.eventName) {
                events = events.filter(event => event.name === params.eventName)
            }

            // Filter by block range
            if (params.fromBlock !== undefined) {
                const fromBlock = params.fromBlock
                events = events.filter(
                    event => event.blockHeight >= fromBlock,
                )
            }
            if (params.toBlock !== undefined) {
                const toBlock = params.toBlock
                events = events.filter(
                    event => event.blockHeight <= toBlock,
                )
            }

            const totalCount = events.length

            // Sort events
            const order = params.order || "desc"
            events.sort((a, b) => {
                const aTime = a.blockHeight
                const bTime = b.blockHeight
                return order === "asc" ? aTime - bTime : bTime - aTime
            })

            // Apply pagination
            const limit = Math.min(params.limit || 50, 1000) // Max 1000 events per query
            const offset = params.offset || 0
            const paginatedEvents = events.slice(offset, offset + limit)

            // Add contract address to each event (events in DB might not have it)
            const eventsWithAddress = paginatedEvents.map((event, index) => ({
                ...event,
                contractAddress,
                eventIndex: index, // Add eventIndex for API compatibility
            }))

            return {
                events: eventsWithAddress,
                totalCount,
                hasMore: offset + limit < totalCount,
                pagination: {
                    limit,
                    offset,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(totalCount / limit),
                },
            }
        } catch (error) {
            console.error(
                "[EventManager] Error querying contract events:",
                error,
            )
            throw new Error(`Failed to query contract events: ${error}`)
        }
    }

    /**
     * Query events by name across all contracts
     */
    static async getEventsByName(
        eventName: string,
        params: Omit<EventQueryParams, "eventName"> = {},
    ): Promise<EventQueryResponse> {
        try {
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            // Get all contracts that have this event name
            const contracts = await gcrRepo
                .createQueryBuilder("gcr")
                .where("gcr.contract IS NOT NULL")
                .andWhere(
                    "jsonb_path_exists(gcr.contract, '$.events[*] ? (@.name == $name)')",
                    { name: eventName },
                )
                .getMany()

            let allEvents: ContractEvent[] = []

            // Collect events from all contracts
            for (const contract of contracts) {
                if (contract.contract && contract.contract.events) {
                    const contractEvents = contract.contract.events
                        .filter(event => event.name === eventName)
                        .map((event, index) => ({
                            ...event,
                            contractAddress: contract.pubkey,
                            eventIndex: index, // Add eventIndex for API compatibility
                        }))
                    allEvents.push(...contractEvents)
                }
            }

            // Apply filters
            if (params.fromBlock !== undefined) {
                const fromBlock = params.fromBlock
                allEvents = allEvents.filter(
                    event => event.blockHeight >= fromBlock,
                )
            }
            if (params.toBlock !== undefined) {
                const toBlock = params.toBlock
                allEvents = allEvents.filter(
                    event => event.blockHeight <= toBlock,
                )
            }
            if (params.contractAddress) {
                allEvents = allEvents.filter(
                    event => event.contractAddress === params.contractAddress,
                )
            }

            const totalCount = allEvents.length

            // Sort events
            const order = params.order || "desc"
            allEvents.sort((a, b) => {
                const aTime = a.blockHeight
                const bTime = b.blockHeight
                return order === "asc" ? aTime - bTime : bTime - aTime
            })

            // Apply pagination
            const limit = Math.min(params.limit || 50, 1000)
            const offset = params.offset || 0
            const paginatedEvents = allEvents.slice(offset, offset + limit)

            return {
                events: paginatedEvents,
                totalCount,
                hasMore: offset + limit < totalCount,
                pagination: {
                    limit,
                    offset,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(totalCount / limit),
                },
            }
        } catch (error) {
            console.error(
                "[EventManager] Error querying events by name:",
                error,
            )
            throw new Error(`Failed to query events by name: ${error}`)
        }
    }

    /**
     * Query events in a specific block range
     */
    static async getEventsInRange(
        fromBlock: number,
        toBlock: number,
        params: Omit<EventQueryParams, "fromBlock" | "toBlock"> = {},
    ): Promise<EventQueryResponse> {
        try {
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            // Get all contracts that have events in the block range
            const contracts = await gcrRepo
                .createQueryBuilder("gcr")
                .where("gcr.contract IS NOT NULL")
                .andWhere(
                    "jsonb_path_exists(gcr.contract, '$.events[*] ? (@.blockHeight >= $from && @.blockHeight <= $to)')",
                    { from: fromBlock, to: toBlock },
                )
                .getMany()

            let allEvents: ContractEvent[] = []

            // Collect events from all contracts
            for (const contract of contracts) {
                if (contract.contract && contract.contract.events) {
                    const contractEvents = contract.contract.events
                        .filter(
                            event =>
                                event.blockHeight >= fromBlock &&
                                event.blockHeight <= toBlock,
                        )
                        .map((event, index) => ({
                            ...event,
                            contractAddress: contract.pubkey,
                            eventIndex: index, // Add eventIndex for API compatibility
                        }))
                    allEvents.push(...contractEvents)
                }
            }

            // Apply additional filters
            if (params.contractAddress) {
                allEvents = allEvents.filter(
                    event => event.contractAddress === params.contractAddress,
                )
            }
            if (params.eventName) {
                allEvents = allEvents.filter(
                    event => event.name === params.eventName,
                )
            }

            const totalCount = allEvents.length

            // Sort events
            const order = params.order || "desc"
            allEvents.sort((a, b) => {
                const aTime = a.blockHeight
                const bTime = b.blockHeight
                return order === "asc" ? aTime - bTime : bTime - aTime
            })

            // Apply pagination
            const limit = Math.min(params.limit || 50, 1000)
            const offset = params.offset || 0
            const paginatedEvents = allEvents.slice(offset, offset + limit)

            return {
                events: paginatedEvents,
                totalCount,
                hasMore: offset + limit < totalCount,
                pagination: {
                    limit,
                    offset,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(totalCount / limit),
                },
            }
        } catch (error) {
            console.error(
                "[EventManager] Error querying events in range:",
                error,
            )
            throw new Error(`Failed to query events in range: ${error}`)
        }
    }

    /**
     * Get event statistics for a contract
     */
    static async getContractEventStats(
        contractAddress: string,
    ): Promise<ContractEventStats | null> {
        try {
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            const contract = await gcrRepo.findOne({
                where: { pubkey: contractAddress },
            })

            if (!contract || !contract.contract) {
                return null
            }

            const events = contract.contract.events || []

            if (events.length === 0) {
                return {
                    contractAddress,
                    totalEvents: 0,
                    eventTypes: 0,
                    eventCountsByName: {},
                }
            }

            // Calculate statistics
            const eventCountsByName: Record<string, number> = {}
            const eventTypes = new Set<string>()
            let firstEvent: Date | undefined
            let lastEvent: Date | undefined

            events.forEach(event => {
                // Count by name
                eventCountsByName[event.name] =
                    (eventCountsByName[event.name] || 0) + 1
                eventTypes.add(event.name)

                // Track first/last event timestamps
                const eventTime = new Date(event.timestamp)
                if (!firstEvent || eventTime < firstEvent) {
                    firstEvent = eventTime
                }
                if (!lastEvent || eventTime > lastEvent) {
                    lastEvent = eventTime
                }
            })

            return {
                contractAddress,
                totalEvents: events.length,
                eventTypes: eventTypes.size,
                firstEvent,
                lastEvent,
                eventCountsByName,
            }
        } catch (error) {
            console.error("[EventManager] Error getting contract stats:", error)
            throw new Error(`Failed to get contract event stats: ${error}`)
        }
    }

    /**
     * Add events to a contract (called during contract execution)
     */
    static async addEventsToContract(
        contractAddress: string,
        events: Array<{
            name: string
            args: Record<string, any>
            blockHeight: number
            timestamp: Date
            txHash?: string
        }>,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const db = await Datasource.getInstance()
            const gcrRepo = db.getDataSource().getRepository(GCRMain)

            const contract = await gcrRepo.findOne({
                where: { pubkey: contractAddress },
            })

            if (!contract || !contract.contract) {
                return {
                    success: false,
                    error: "Contract not found",
                }
            }

            // Transform and add events with contract address and missing fields
            const transformedEvents = events.map((event, index) => ({
                name: event.name,
                args: event.args,
                contractAddress,
                blockHeight: event.blockHeight,
                transactionHash: event.txHash || "",
                timestamp: event.timestamp,
                eventIndex: index,
            }))

            // Append to existing events
            if (!contract.contract.events) {
                contract.contract.events = []
            }
            contract.contract.events.push(...transformedEvents)

            // Update metadata
            contract.contract.metadata.updatedAt = new Date()

            // Save to database
            await gcrRepo.save(contract)

            return { success: true }
        } catch (error) {
            console.error(
                "[EventManager] Error adding events to contract:",
                error,
            )
            return {
                success: false,
                error: `Failed to add events: ${error}`,
            }
        }
    }

    /**
     * Batch query for multiple contracts
     */
    static async batchQuery(
        query: BatchEventQuery,
    ): Promise<Record<string, EventQueryResponse>> {
        const results: Record<string, EventQueryResponse> = {}

        // Query each contract
        for (const contractAddress of query.contractAddresses) {
            try {
                const contractParams = {
                    ...query.params,
                    contractAddress,
                }

                results[contractAddress] = await this.getContractEvents(
                    contractAddress,
                    contractParams,
                )
            } catch (error) {
                // Store error result for this contract
                results[contractAddress] = {
                    events: [],
                    totalCount: 0,
                    hasMore: false,
                    pagination: {
                        limit: query.params.limit || 50,
                        offset: query.params.offset || 0,
                        currentPage: 1,
                        totalPages: 0,
                    },
                }
            }
        }

        return results
    }
}
