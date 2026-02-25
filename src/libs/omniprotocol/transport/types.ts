/* eslint-disable @typescript-eslint/naming-convention */
// REVIEW: Transport layer type definitions for OmniProtocol TCP connections

/**
 * Connection state machine for bidirectional TCP connections
 *
 * States are on a numeric scale:
 * - Negative values: Connection is not usable (terminal/error states)
 * - Zero: Initial/transitional state
 * - Positive values (1-9): Connecting but not yet usable
 * - Positive values (10+): Connection is usable for messaging
 *
 * State flow for OUTBOUND connections:
 * UNINITIALIZED(0) → CONNECTING(1) → CONNECTED(2) → READY(11)
 *
 * State flow for INBOUND connections:
 * CONNECTED(2) → PENDING_AUTH(3) → READY(11)
 *
 * Both can transition to:
 * → IDLE(10) → CLOSING(-1) → CLOSED(-2)
 * → ERROR(-3) (from any state on failure)
 */
export const ConnectionState = {
    // Terminal/Error states (negative - not usable)
    ERROR: -3,
    CLOSED: -2,
    CLOSING: -1,

    // Initial state (zero)
    UNINITIALIZED: 0,

    // Connecting states (positive 1-9, not yet usable)
    CONNECTING: 1,
    CONNECTED: 2,
    PENDING_AUTH: 3,

    // Usable states (positive 10+)
    AUTHENTICATED: 10,
    READY: 11,
    IDLE: 10,
} as const

export type ConnectionStateValue = typeof ConnectionState[keyof typeof ConnectionState]

/**
 * Connection origin - who initiated the TCP connection
 */
export type ConnectionOrigin = "inbound" | "outbound"

/**
 * Utility functions for ConnectionState operations
 */
export const ConnectionStateUtils = {
    /**
     * Check if connection can be used for sending/receiving messages
     * State must be >= AUTHENTICATED (10)
     */
    isUsable(state: ConnectionStateValue): boolean {
        return state >= ConnectionState.AUTHENTICATED
    },

    /**
     * Check if TCP socket is connected (even if not authenticated)
     * State must be >= CONNECTED (2)
     */
    isConnected(state: ConnectionStateValue): boolean {
        return state >= ConnectionState.CONNECTED
    },

    /**
     * Check if connection is in a terminal state (closing/closed/error)
     * State must be <= CLOSING (-1)
     */
    isTerminal(state: ConnectionStateValue): boolean {
        return state <= ConnectionState.CLOSING
    },

    /**
     * Check if connection is in an error state
     */
    isError(state: ConnectionStateValue): boolean {
        return state === ConnectionState.ERROR
    },

    /**
     * Check if connection needs authentication
     */
    needsAuth(state: ConnectionStateValue): boolean {
        return state === ConnectionState.CONNECTED ||
               state === ConnectionState.PENDING_AUTH
    },

    /**
     * Get human-readable state name
     */
    getName(state: ConnectionStateValue): string {
        const entry = Object.entries(ConnectionState).find(([_, v]) => v === state)
        return entry ? entry[0] : `UNKNOWN(${state})`
    },

    /**
     * Check if state transition is valid
     */
    canTransition(from: ConnectionStateValue, to: ConnectionStateValue): boolean {
        // Can always transition to terminal states
        if (to <= ConnectionState.CLOSING) return true

        // Can't transition from terminal states (except CLOSING → CLOSED)
        if (from <= ConnectionState.CLOSING) {
            return from === ConnectionState.CLOSING && to === ConnectionState.CLOSED
        }

        // Generally, can move forward (higher value) or to IDLE
        return to > from || to === ConnectionState.IDLE
    },
}

/**
 * Sequence ID ranges for bidirectional connections
 * Outbound-initiated connections use low range, inbound use high range
 * This prevents sequence ID collisions when both sides send requests
 */
export const SequenceIdRange = {
    OUTBOUND_START: 0x00000001,
    OUTBOUND_END: 0x7FFFFFFF,
    INBOUND_START: 0x80000001,
    INBOUND_END: 0xFFFFFFFF,
} as const

/**
 * Options for connection acquisition and operations
 */
export interface ConnectionOptions {
    /** Operation timeout in milliseconds (default: 3000) */
    timeout?: number
    /** Number of retry attempts (default: 0) */
    retries?: number
    /** Priority level for queueing (future use) */
    priority?: "high" | "normal" | "low"
}

/**
 * Pending request awaiting response
 * Stored in PeerConnection's inFlightRequests map
 */
export interface PendingRequest {
    /** Resolve promise with response payload */
    resolve: (response: Buffer) => void
    /** Reject promise with error */
    reject: (error: Error) => void
    /** Timeout timer to clear on response */
    timer: NodeJS.Timeout
    /** Timestamp when request was sent (for metrics) */
    sentAt: number
}

/**
 * Configuration for connection pool
 */
export interface PoolConfig {
    /** Maximum total connections across all peers */
    maxTotalConnections: number
    /** Maximum connections per individual peer (default: 1) */
    maxConnectionsPerPeer: number
    /** Idle timeout in milliseconds (default: 10 minutes) */
    idleTimeout: number
    /** Connection establishment timeout in milliseconds (default: 5 seconds) */
    connectTimeout: number
    /** Authentication timeout in milliseconds (default: 5 seconds) */
    authTimeout: number
}

/**
 * Connection pool statistics
 */
export interface PoolStats {
    /** Total connections in pool (all states) */
    totalConnections: number
    /** Connections in READY state */
    activeConnections: number
    /** Connections in IDLE_PENDING state */
    idleConnections: number
    /** Connections in CONNECTING/AUTHENTICATING state */
    connectingConnections: number
    /** Connections in ERROR/CLOSED state */
    deadConnections: number
}

/**
 * Connection information for a peer
 */
export interface ConnectionInfo {
    /** Peer identity (public key) */
    peerIdentity: string
    /** Connection string (e.g., "tcp://ip:port") */
    connectionString: string
    /** Current connection state (numeric) */
    state: ConnectionStateValue
    /** Timestamp when connection was established */
    connectedAt: number | null
    /** Timestamp of last activity */
    lastActivity: number
    /** Number of in-flight requests */
    inFlightCount: number
}

/**
 * Parsed connection string components
 */
export interface ParsedConnectionString {
    /** Protocol: 'tcp', 'tls', or 'tcps' (TLS) */
    protocol: "tcp" | "tls" | "tcps"
    /** Hostname or IP address */
    host: string
    /** Port number */
    port: number
}

// REVIEW: Re-export centralized error classes from types/errors.ts for backward compatibility
export {
    PoolCapacityError,
    ConnectionTimeoutError,
    AuthenticationError,
} from "../types/errors"

/**
 * Parse connection string into components
 * @param connectionString Format: "tcp://host:port", "tls://host:port", or "tcps://host:port"
 * @returns Parsed components
 * @throws Error if format is invalid
 */
export function parseConnectionString(
    connectionString: string,
): ParsedConnectionString {
    const match = connectionString.match(/^(tcp|tls|tcps):\/\/([^:]+):(\d+)$/)
    if (!match) {
        throw new Error(
            `Invalid connection string format: ${connectionString}. Expected tcp://host:port`,
        )
    }

    return {
        protocol: match[1] as "tcp" | "tls" | "tcps",
        host: match[2],
        port: parseInt(match[3], 10),
    }
}
