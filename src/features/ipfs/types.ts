/**
 * IPFS Integration Types for Demos Network
 *
 * Type definitions for IPFS operations, configuration, and state management.
 *
 * @fileoverview IPFS type definitions
 */

/**
 * Configuration for IPFSManager initialization
 */
export interface IpfsManagerConfig {
    /** Kubo HTTP API URL (internal Docker network) */
    apiUrl: string;
    /** Connection timeout in milliseconds */
    timeout?: number;
    /** Enable verbose logging */
    debug?: boolean;
}

/**
 * IPFS node identity information
 */
export interface IpfsNodeInfo {
    /** Peer ID (base58 encoded) */
    peerId: string;
    /** Public key */
    publicKey?: string;
    /** Agent version string */
    agentVersion: string;
    /** Protocol version */
    protocolVersion: string;
    /** Listening addresses */
    addresses: string[];
}

/**
 * IPFS node health status
 */
export interface IpfsHealthStatus {
    /** Whether the IPFS node is reachable */
    healthy: boolean;
    /** Peer ID if healthy */
    peerId?: string;
    /** Number of connected peers */
    peerCount?: number;
    /** Repository size in bytes */
    repoSize?: number;
    /** Error message if unhealthy */
    error?: string;
    /** Timestamp of health check */
    timestamp: number;
}

/**
 * Pin information stored in account state
 * // REVIEW: This will be used in Phase 2 (Account State Schema)
 */
export interface IpfsPin {
    /** Content identifier */
    cid: string;
    /** Size in bytes */
    size: number;
    /** Timestamp when pinned (Unix ms) */
    timestamp: number;
    /** Optional expiration timestamp */
    expiresAt?: number;
    /** Optional user metadata */
    metadata?: Record<string, unknown>;
}

/**
 * Account-level IPFS state
 * // REVIEW: This will be used in Phase 2 (Account State Schema)
 */
export interface AccountIpfsState {
    /** List of pinned content */
    pins: IpfsPin[];
    /** Total bytes pinned by this account */
    totalPinnedBytes: number;
    /** Cumulative rewards earned for hosting */
    earnedRewards: bigint;
    /** Cumulative costs paid for pinning */
    paidCosts: bigint;
}

/**
 * Get the IPFS API URL based on environment
 * Uses IPFS_API_PORT env var set by ./run script (PORT + 1000)
 */
function getDefaultIpfsApiUrl(): string {
    // In production, use localhost with port from environment
    const port = process.env.IPFS_API_PORT || "54550"
    return `http://127.0.0.1:${port}`
}

/**
 * Default configuration values
 */
export const IPFS_DEFAULTS = {
    /** Default Kubo API URL (localhost with port from IPFS_API_PORT env) */
    get API_URL(): string {
        return getDefaultIpfsApiUrl()
    },
    /** Default timeout in milliseconds */
    TIMEOUT: 30000,
    /** Health check interval in milliseconds */
    HEALTH_CHECK_INTERVAL: 30000,
} as const


// ============================================================================
// Streaming Types (Phase 8)
// ============================================================================

/**
 * Progress callback for streaming operations
 * @param bytesTransferred - Number of bytes transferred so far
 * @param totalBytes - Total bytes (if known), undefined for unknown size
 */
export type StreamProgressCallback = (bytesTransferred: number, totalBytes?: number) => void

/**
 * Options for streaming add operation
 */
export interface AddStreamOptions {
    /** Optional filename for the content */
    filename?: string
    /** Progress callback fired during upload */
    onProgress?: StreamProgressCallback
}

/**
 * Options for streaming get operation
 */
export interface GetStreamOptions {
    /** Progress callback fired during download */
    onProgress?: StreamProgressCallback
}

/**
 * Default chunk size for streaming operations (256KB)
 */
export const STREAM_CHUNK_SIZE = 256 * 1024
