// REVIEW: Transport layer type definitions for OmniProtocol TCP connections

/**
 * Connection state machine for TCP connections
 *
 * State flow:
 * UNINITIALIZED → CONNECTING → AUTHENTICATING → READY → IDLE_PENDING → CLOSING → CLOSED
 *                      ↓             ↓              ↓
 *                    ERROR ←---------┴--------------┘
 */
export type ConnectionState =
    | "UNINITIALIZED" // Not yet connected
    | "CONNECTING" // TCP handshake in progress
    | "AUTHENTICATING" // hello_peer (0x01) exchange in progress
    | "READY" // Connected, authenticated, ready for messages
    | "IDLE_PENDING" // Idle timeout reached, will close when in-flight complete
    | "CLOSING" // Graceful shutdown in progress
    | "CLOSED" // Connection terminated
    | "ERROR" // Error state, can retry

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
    /** Current connection state */
    state: ConnectionState
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
