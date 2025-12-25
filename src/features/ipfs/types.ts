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


// ============================================================================
// REVIEW: Swarm and Cluster Types (Phase 4)
// ============================================================================

/**
 * Swarm configuration for private IPFS network
 * Uses swarm key to create isolated network of Demos nodes
 */
export interface SwarmConfig {
    /** 64-byte hex swarm key for private network */
    swarmKey?: string
    /** Bootstrap node multiaddresses */
    bootstrapNodes: string[]
    /** Force private network mode (LIBP2P_FORCE_PNET=1) */
    forcePrivateNetwork: boolean
    /** Maximum number of peer connections */
    maxPeers?: number
    /** Minimum number of peer connections to maintain */
    minPeers?: number
}

/**
 * Information about a connected swarm peer
 */
export interface SwarmPeerInfo {
    /** Peer ID (base58 encoded) */
    peerId: string
    /** Multiaddress of the peer connection */
    addr: string
    /** Connection direction: inbound or outbound */
    direction: "inbound" | "outbound"
    /** Latency in milliseconds (if available) */
    latency?: number
    /** Streams/protocols supported by this peer */
    streams?: string[]
    /** Whether this is a Demos network node */
    isDemosNode?: boolean
}

/**
 * Options for cluster-wide pinning
 */
export interface ClusterPinOptions {
    /** Target replication factor (number of nodes to pin on) */
    replication?: number
    /** Pin name/label for identification */
    name?: string
    /** Pin expiration timestamp (Unix ms) */
    expiresAt?: number
    /** Optional metadata */
    metadata?: Record<string, unknown>
}

/**
 * Result of a cluster pin operation
 */
export interface ClusterPinResult {
    /** Content identifier */
    cid: string
    /** Number of nodes that successfully pinned */
    replicatedTo: number
    /** Target replication factor */
    targetReplication: number
    /** Peer IDs that pinned the content */
    pinnedBy: string[]
    /** Any errors during replication */
    errors?: Array<{ peerId: string; error: string }>
}

/**
 * Swarm connection result
 */
export interface SwarmConnectResult {
    /** Whether connection was successful */
    success: boolean
    /** Peer ID connected to */
    peerId?: string
    /** Error message if failed */
    error?: string
}

/**
 * Bootstrap node information
 */
export interface BootstrapNode {
    /** Multiaddress of the bootstrap node */
    addr: string
    /** Whether this node is currently reachable */
    reachable?: boolean
    /** Last seen timestamp */
    lastSeen?: number
}

/**
 * Get swarm configuration from environment variables
 */
export function getSwarmConfigFromEnv(): SwarmConfig {
    const swarmKey = process.env.DEMOS_IPFS_SWARM_KEY
    const bootstrapNodesStr = process.env.DEMOS_IPFS_BOOTSTRAP_NODES || ""
    const forcePrivateNetwork = process.env.LIBP2P_FORCE_PNET === "1"
    const maxPeers = process.env.DEMOS_IPFS_MAX_PEERS
        ? parseInt(process.env.DEMOS_IPFS_MAX_PEERS, 10)
        : undefined
    const minPeers = process.env.DEMOS_IPFS_MIN_PEERS
        ? parseInt(process.env.DEMOS_IPFS_MIN_PEERS, 10)
        : undefined

    // Parse bootstrap nodes (comma-separated multiaddresses)
    const bootstrapNodes = bootstrapNodesStr
        .split(",")
        .map((addr) => addr.trim())
        .filter((addr) => addr.length > 0)

    return {
        swarmKey,
        bootstrapNodes,
        forcePrivateNetwork,
        maxPeers,
        minPeers,
    }
}

/**
 * Default swarm configuration values
 */
export const SWARM_DEFAULTS = {
    /** Default maximum peers */
    MAX_PEERS: 100,
    /** Default minimum peers to maintain */
    MIN_PEERS: 4,
    /** Default replication factor for cluster pins */
    DEFAULT_REPLICATION: 3,
    /** Peer discovery interval in milliseconds */
    PEER_DISCOVERY_INTERVAL: 60000,
    /** Connection timeout for peer connections */
    PEER_CONNECT_TIMEOUT: 10000,
} as const


// ============================================================================
// REVIEW: Public Bridge Types (Phase 5)
// ============================================================================

/**
 * Configuration for public IPFS network bridge
 *
 * Allows optional access to public IPFS network for content retrieval.
 * By default, Demos nodes operate in private-only mode.
 */
export interface PublicBridgeConfig {
    /** Whether public bridge is enabled (default: false) */
    enabled: boolean
    /** Public IPFS gateway URL for fetching content */
    gatewayUrl: string
    /** Whether to allow publishing to public IPFS (default: false) */
    allowPublish: boolean
    /** Request timeout for public gateway in milliseconds */
    timeout: number
    /** Rate limit: maximum requests per minute */
    maxRequestsPerMinute: number
    /** Rate limit: maximum bytes per minute */
    maxBytesPerMinute: number
}

/**
 * Result of fetching content from public IPFS gateway
 */
export interface PublicFetchResult {
    /** Whether fetch was successful */
    success: boolean
    /** Content data if successful */
    content?: Buffer
    /** Size in bytes */
    size?: number
    /** Source gateway URL used */
    gateway?: string
    /** Error message if failed */
    error?: string
    /** Response time in milliseconds */
    responseTimeMs?: number
}

/**
 * Result of publishing content to public IPFS
 */
export interface PublicPublishResult {
    /** Whether publish was successful */
    success: boolean
    /** CID of the published content */
    cid?: string
    /** Error message if failed */
    error?: string
}

/**
 * Status of public bridge availability check
 */
export interface PublicAvailabilityResult {
    /** Whether content is available on public IPFS */
    available: boolean
    /** Gateway where content was found */
    gateway?: string
    /** Response time in milliseconds */
    responseTimeMs?: number
    /** Error message if check failed */
    error?: string
}

/**
 * Rate limit status for public bridge
 */
export interface RateLimitStatus {
    /** Current requests this minute */
    requestsThisMinute: number
    /** Current bytes transferred this minute */
    bytesThisMinute: number
    /** Whether rate limit is exceeded */
    isLimited: boolean
    /** Seconds until rate limit resets */
    resetInSeconds: number
}

/**
 * Get public bridge configuration from environment variables
 */
export function getPublicBridgeConfigFromEnv(): PublicBridgeConfig {
    const enabled = process.env.DEMOS_IPFS_PUBLIC_BRIDGE_ENABLED === "true"
    const gatewayUrl = process.env.DEMOS_IPFS_PUBLIC_GATEWAY || "https://ipfs.io"
    const allowPublish = process.env.DEMOS_IPFS_ALLOW_PUBLIC_PUBLISH === "true"
    const timeout = process.env.DEMOS_IPFS_PUBLIC_TIMEOUT
        ? parseInt(process.env.DEMOS_IPFS_PUBLIC_TIMEOUT, 10)
        : PUBLIC_BRIDGE_DEFAULTS.TIMEOUT
    const maxRequestsPerMinute = process.env.DEMOS_IPFS_PUBLIC_MAX_REQUESTS
        ? parseInt(process.env.DEMOS_IPFS_PUBLIC_MAX_REQUESTS, 10)
        : PUBLIC_BRIDGE_DEFAULTS.MAX_REQUESTS_PER_MINUTE
    const maxBytesPerMinute = process.env.DEMOS_IPFS_PUBLIC_MAX_BYTES
        ? parseInt(process.env.DEMOS_IPFS_PUBLIC_MAX_BYTES, 10)
        : PUBLIC_BRIDGE_DEFAULTS.MAX_BYTES_PER_MINUTE

    return {
        enabled,
        gatewayUrl,
        allowPublish,
        timeout,
        maxRequestsPerMinute,
        maxBytesPerMinute,
    }
}

/**
 * Default public bridge configuration values
 */
export const PUBLIC_BRIDGE_DEFAULTS = {
    /** Default gateway URL */
    GATEWAY_URL: "https://ipfs.io",
    /** Alternative public gateways for fallback */
    FALLBACK_GATEWAYS: [
        "https://dweb.link",
        "https://cloudflare-ipfs.com",
        "https://gateway.pinata.cloud",
    ] as string[],
    /** Default timeout in milliseconds */
    TIMEOUT: 30000,
    /** Maximum requests per minute (rate limiting) */
    MAX_REQUESTS_PER_MINUTE: 30,
    /** Maximum bytes per minute (100 MB) */
    MAX_BYTES_PER_MINUTE: 100 * 1024 * 1024,
    /** Cache TTL for availability checks in milliseconds */
    AVAILABILITY_CACHE_TTL: 60000,
} as const
