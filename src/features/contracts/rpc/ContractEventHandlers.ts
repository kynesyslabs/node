/**
 * RPC endpoint handlers for contract events
 */

import { EventManager } from "../events/EventManager"
import {
    GetContractEventsRequest,
    GetEventsByNameRequest,
    GetEventsInRangeRequest,
    GetContractEventStatsRequest,
    EventRPCResponse,
    EventQueryResponse,
    ContractEventStats,
} from "../events/EventTypes"

/**
 * Handle getContractEvents RPC request
 */
export async function handleGetContractEvents(
    params: GetContractEventsRequest["params"],
): Promise<EventRPCResponse<EventQueryResponse>> {
    try {
        // Validate contract address
        if (!params.contractAddress) {
            return {
                success: false,
                error: "Contract address is required",
            }
        }

        // Validate contract address format (basic hex check)
        if (!/^[a-fA-F0-9]{64}$/.test(params.contractAddress)) {
            return {
                success: false,
                error: "Invalid contract address format",
            }
        }

        // Query events
        const result = await EventManager.getContractEvents(
            params.contractAddress,
            params.queryParams || {},
        )

        return {
            success: true,
            data: result,
            message: `Found ${result.totalCount} events for contract`,
        }
    } catch (error) {
        console.error("[handleGetContractEvents] Error:", error)
        return {
            success: false,
            error: `Failed to get contract events: ${error}`,
        }
    }
}

/**
 * Handle getEventsByName RPC request
 */
export async function handleGetEventsByName(
    params: GetEventsByNameRequest["params"],
): Promise<EventRPCResponse<EventQueryResponse>> {
    try {
        // Validate event name
        if (!params.eventName) {
            return {
                success: false,
                error: "Event name is required",
            }
        }

        // Validate event name format (alphanumeric + underscore)
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(params.eventName)) {
            return {
                success: false,
                error: "Invalid event name format",
            }
        }

        // Query events
        const result = await EventManager.getEventsByName(
            params.eventName,
            params.queryParams || {},
        )

        return {
            success: true,
            data: result,
            message: `Found ${result.totalCount} '${params.eventName}' events`,
        }
    } catch (error) {
        console.error("[handleGetEventsByName] Error:", error)
        return {
            success: false,
            error: `Failed to get events by name: ${error}`,
        }
    }
}

/**
 * Handle getEventsInRange RPC request
 */
export async function handleGetEventsInRange(
    params: GetEventsInRangeRequest["params"],
): Promise<EventRPCResponse<EventQueryResponse>> {
    try {
        // Validate block range
        if (params.fromBlock === undefined || params.toBlock === undefined) {
            return {
                success: false,
                error: "Both fromBlock and toBlock are required",
            }
        }

        if (params.fromBlock < 0 || params.toBlock < 0) {
            return {
                success: false,
                error: "Block numbers must be non-negative",
            }
        }

        if (params.fromBlock > params.toBlock) {
            return {
                success: false,
                error: "fromBlock must be less than or equal to toBlock",
            }
        }

        // Limit block range to prevent excessive queries
        const blockRange = params.toBlock - params.fromBlock
        if (blockRange > 10000) {
            return {
                success: false,
                error: "Block range too large (maximum 10,000 blocks)",
            }
        }

        // Query events
        const result = await EventManager.getEventsInRange(
            params.fromBlock,
            params.toBlock,
            params.queryParams || {},
        )

        return {
            success: true,
            data: result,
            message: `Found ${result.totalCount} events in block range ${params.fromBlock}-${params.toBlock}`,
        }
    } catch (error) {
        console.error("[handleGetEventsInRange] Error:", error)
        return {
            success: false,
            error: `Failed to get events in range: ${error}`,
        }
    }
}

/**
 * Handle getContractEventStats RPC request
 */
export async function handleGetContractEventStats(
    params: GetContractEventStatsRequest["params"],
): Promise<EventRPCResponse<ContractEventStats>> {
    try {
        // Validate contract address
        if (!params.contractAddress) {
            return {
                success: false,
                error: "Contract address is required",
            }
        }

        // Validate contract address format
        if (!/^[a-fA-F0-9]{64}$/.test(params.contractAddress)) {
            return {
                success: false,
                error: "Invalid contract address format",
            }
        }

        // Get stats
        const stats = await EventManager.getContractEventStats(
            params.contractAddress,
        )

        if (!stats) {
            return {
                success: false,
                error: "Contract not found or has no events",
            }
        }

        return {
            success: true,
            data: stats,
            message: "Retrieved event statistics for contract",
        }
    } catch (error) {
        console.error("[handleGetContractEventStats] Error:", error)
        return {
            success: false,
            error: `Failed to get contract event stats: ${error}`,
        }
    }
}

/**
 * Handle batch event query (get events from multiple contracts)
 */
export async function handleBatchEventQuery(params: {
    contractAddresses: string[]
    queryParams?: any
}): Promise<EventRPCResponse<Record<string, EventQueryResponse>>> {
    try {
        // Validate input
        if (
            !params.contractAddresses ||
            !Array.isArray(params.contractAddresses)
        ) {
            return {
                success: false,
                error: "Contract addresses array is required",
            }
        }

        if (params.contractAddresses.length === 0) {
            return {
                success: false,
                error: "At least one contract address is required",
            }
        }

        // Limit batch size
        if (params.contractAddresses.length > 50) {
            return {
                success: false,
                error: "Maximum 50 contracts per batch query",
            }
        }

        // Validate each address
        for (const address of params.contractAddresses) {
            if (!/^[a-fA-F0-9]{64}$/.test(address)) {
                return {
                    success: false,
                    error: `Invalid contract address format: ${address}`,
                }
            }
        }

        // Execute batch query
        const result = await EventManager.batchQuery({
            contractAddresses: params.contractAddresses,
            params: params.queryParams || {},
        })

        return {
            success: true,
            data: result,
            message: `Batch query completed for ${params.contractAddresses.length} contracts`,
        }
    } catch (error) {
        console.error("[handleBatchEventQuery] Error:", error)
        return {
            success: false,
            error: `Failed to execute batch event query: ${error}`,
        }
    }
}

/**
 * Utility function to validate common query parameters
 */
export function validateQueryParams(params: any): {
    valid: boolean
    error?: string
} {
    if (params.limit !== undefined) {
        if (
            !Number.isInteger(params.limit) ||
            params.limit < 1 ||
            params.limit > 1000
        ) {
            return {
                valid: false,
                error: "Limit must be an integer between 1 and 1000",
            }
        }
    }

    if (params.offset !== undefined) {
        if (!Number.isInteger(params.offset) || params.offset < 0) {
            return {
                valid: false,
                error: "Offset must be a non-negative integer",
            }
        }
    }

    if (params.order !== undefined) {
        if (params.order !== "asc" && params.order !== "desc") {
            return {
                valid: false,
                error: "Order must be 'asc' or 'desc'",
            }
        }
    }

    if (params.fromBlock !== undefined) {
        if (!Number.isInteger(params.fromBlock) || params.fromBlock < 0) {
            return {
                valid: false,
                error: "fromBlock must be a non-negative integer",
            }
        }
    }

    if (params.toBlock !== undefined) {
        if (!Number.isInteger(params.toBlock) || params.toBlock < 0) {
            return {
                valid: false,
                error: "toBlock must be a non-negative integer",
            }
        }
    }

    return { valid: true }
}
