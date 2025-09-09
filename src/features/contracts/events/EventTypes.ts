/**
 * Event system types for smart contract event emission and querying
 */

/**
 * Contract event data structure
 */
/**
 * Contract event data structure
 */
export interface ContractEvent {
    /** Event name/type */
    name: string
    /** Event data payload */
    args: Record<string, any>
    /** Contract address that emitted the event */
    contractAddress: string
    /** Block height when event was emitted */
    blockHeight: number
    /** Transaction hash that triggered the event */
    transactionHash: string
    /** Timestamp when event was emitted */
    timestamp: Date
    /** Unique event ID within the contract */
    eventIndex: number
}

/**
 * Event query parameters
 */
export interface EventQueryParams {
    /** Contract address to query events from */
    contractAddress?: string
    /** Filter by specific event name */
    eventName?: string
    /** Filter events from this block height (inclusive) */
    fromBlock?: number
    /** Filter events to this block height (inclusive) */
    toBlock?: number
    /** Maximum number of events to return */
    limit?: number
    /** Offset for pagination */
    offset?: number
    /** Sort order - 'asc' for oldest first, 'desc' for newest first */
    order?: "asc" | "desc"
}

/**
 * Event query response
 */
export interface EventQueryResponse {
    /** Array of matching events */
    events: ContractEvent[]
    /** Total number of events matching the query (for pagination) */
    totalCount: number
    /** Whether there are more events available */
    hasMore: boolean
    /** Current page information */
    pagination: {
        limit: number
        offset: number
        currentPage: number
        totalPages: number
    }
}

/**
 * Event statistics for a contract
 */
export interface ContractEventStats {
    /** Contract address */
    contractAddress: string
    /** Total number of events emitted */
    totalEvents: number
    /** Number of unique event types */
    eventTypes: number
    /** First event timestamp */
    firstEvent?: Date
    /** Last event timestamp */
    lastEvent?: Date
    /** Event counts by name */
    eventCountsByName: Record<string, number>
}

/**
 * Event filter options for advanced querying
 */
export interface EventFilter {
    /** Event name pattern (supports wildcards) */
    namePattern?: string
    /** Filter by event data fields */
    dataFilters?: {
        field: string
        operator: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "contains"
        value: any
    }[]
    /** Time range filter */
    timeRange?: {
        start: Date
        end: Date
    }
}

/**
 * Batch event query for multiple contracts
 */
export interface BatchEventQuery {
    /** Array of contract addresses to query */
    contractAddresses: string[]
    /** Common query parameters */
    params: EventQueryParams
    /** Optional per-contract filters */
    contractFilters?: Record<string, EventFilter>
}

/**
 * Event subscription parameters (for future WebSocket support)
 */
export interface EventSubscription {
    /** Contract address to subscribe to */
    contractAddress: string
    /** Event names to subscribe to (empty array = all events) */
    eventNames: string[]
    /** Subscription ID */
    subscriptionId: string
    /** Whether subscription is active */
    active: boolean
}

/**
 * RPC request/response types for event endpoints
 */

export interface GetContractEventsRequest {
    method: "getContractEvents"
    params: {
        contractAddress: string
        queryParams?: Omit<EventQueryParams, "contractAddress">
    }
}

export interface GetEventsByNameRequest {
    method: "getEventsByName"
    params: {
        eventName: string
        queryParams?: Omit<EventQueryParams, "eventName">
    }
}

export interface GetEventsInRangeRequest {
    method: "getEventsInRange"
    params: {
        fromBlock: number
        toBlock: number
        queryParams?: Omit<EventQueryParams, "fromBlock" | "toBlock">
    }
}

export interface GetContractEventStatsRequest {
    method: "getContractEventStats"
    params: {
        contractAddress: string
    }
}

/**
 * Standard RPC response wrapper for event queries
 */
export interface EventRPCResponse<T = any> {
    success: boolean
    data?: T
    error?: string
    message?: string
}

/**
 * Event emission context (used internally during contract execution)
 */
export interface EventEmissionContext {
    /** Current block height */
    blockHeight: number
    /** Current transaction hash */
    transactionHash: string
    /** Contract address emitting the event */
    contractAddress: string
    /** Current timestamp */
    timestamp: Date
}
