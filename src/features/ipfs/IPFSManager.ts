/**
 * IPFS Manager for Demos Network
 *
 * Core class wrapping Kubo HTTP API for IPFS operations.
 * Provides health checking, lifecycle management, and a foundation
 * for content operations (add/get/pin) in subsequent phases.
 *
 * @fileoverview IPFSManager class implementation
 *
 * @example
 * ```typescript
 * import { IPFSManager } from "@/features/ipfs"
 *
 * const ipfs = new IPFSManager()
 * await ipfs.initialize()
 *
 * if (await ipfs.healthCheck()) {
 *   const nodeId = await ipfs.getNodeId()
 *   console.log(`Connected to IPFS node: ${nodeId}`)
 * }
 * ```
 */

import {
    IPFSConnectionError,
    IPFSTimeoutError,
    IPFSAPIError,
} from "./errors"
import {
    type IpfsManagerConfig,
    type IpfsNodeInfo,
    type IpfsHealthStatus,
    IPFS_DEFAULTS,
} from "./types"

/**
 * IPFSManager - Core IPFS integration for Demos Network
 *
 * Manages connection to Kubo IPFS node running in Docker container.
 * All operations are proxied through this class to maintain
 * consistent error handling and lifecycle management.
 */
export class IPFSManager {
    private readonly apiUrl: string
    private readonly timeout: number
    private readonly debug: boolean

    private initialized = false
    private cachedNodeInfo: IpfsNodeInfo | null = null
    private lastHealthCheck: IpfsHealthStatus | null = null

    /**
     * Create a new IPFSManager instance
     *
     * @param config - Configuration options
     */
    constructor(config: Partial<IpfsManagerConfig> = {}) {
        this.apiUrl = config.apiUrl ?? IPFS_DEFAULTS.API_URL
        this.timeout = config.timeout ?? IPFS_DEFAULTS.TIMEOUT
        this.debug = config.debug ?? false

        this.log(`IPFSManager created with API URL: ${this.apiUrl}`)
    }

    /**
     * Initialize the IPFS manager
     *
     * Verifies connection to the Kubo node and caches node information.
     * Should be called once during Demos node startup.
     *
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            this.log("IPFSManager already initialized")
            return
        }

        this.log("Initializing IPFSManager...")

        try {
            // Verify connection by fetching node identity
            this.cachedNodeInfo = await this.fetchNodeInfo()
            this.initialized = true
            this.log(`IPFSManager initialized. Node ID: ${this.cachedNodeInfo.peerId}`)
        } catch (error) {
            throw new IPFSConnectionError(
                `Failed to initialize IPFS connection to ${this.apiUrl}`,
                error instanceof Error ? error : undefined,
            )
        }
    }

    /**
     * Check if the IPFS node is healthy and reachable
     *
     * @returns Health status object with details
     */
    async healthCheck(): Promise<IpfsHealthStatus> {
        const timestamp = Date.now()

        try {
            const nodeInfo = await this.fetchNodeInfo()

            // Optionally fetch peer count for more detailed health info
            let peerCount: number | undefined
            try {
                peerCount = await this.fetchPeerCount()
            } catch {
                // Peer count is optional, don't fail health check
            }

            const status: IpfsHealthStatus = {
                healthy: true,
                peerId: nodeInfo.peerId,
                peerCount,
                timestamp,
            }

            this.lastHealthCheck = status
            return status
        } catch (error) {
            const status: IpfsHealthStatus = {
                healthy: false,
                error: error instanceof Error ? error.message : "Unknown error",
                timestamp,
            }

            this.lastHealthCheck = status
            return status
        }
    }

    /**
     * Get the IPFS node's peer ID
     *
     * @returns Peer ID string (base58 encoded)
     * @throws {IPFSConnectionError} If unable to fetch node ID
     */
    async getNodeId(): Promise<string> {
        // Use cached info if available and recent
        if (this.cachedNodeInfo) {
            return this.cachedNodeInfo.peerId
        }

        const nodeInfo = await this.fetchNodeInfo()
        this.cachedNodeInfo = nodeInfo
        return nodeInfo.peerId
    }

    /**
     * Get detailed node information
     *
     * @returns Full node info including addresses
     * @throws {IPFSConnectionError} If unable to fetch node info
     */
    async getNodeInfo(): Promise<IpfsNodeInfo> {
        if (this.cachedNodeInfo) {
            return this.cachedNodeInfo
        }

        const nodeInfo = await this.fetchNodeInfo()
        this.cachedNodeInfo = nodeInfo
        return nodeInfo
    }

    /**
     * Get last health check result without performing a new check
     *
     * @returns Last health status or null if never checked
     */
    getLastHealthStatus(): IpfsHealthStatus | null {
        return this.lastHealthCheck
    }

    /**
     * Check if manager is initialized
     */
    isInitialized(): boolean {
        return this.initialized
    }

    /**
     * Shutdown the IPFS manager
     *
     * Clears cached state. Does not stop the Docker container.
     */
    async shutdown(): Promise<void> {
        this.log("Shutting down IPFSManager...")
        this.initialized = false
        this.cachedNodeInfo = null
        this.lastHealthCheck = null
        this.log("IPFSManager shutdown complete")
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    /**
     * Fetch node identity from Kubo API
     */
    private async fetchNodeInfo(): Promise<IpfsNodeInfo> {
        const response = await this.apiRequest("/api/v0/id", "POST")
        const data = await response.json()

        return {
            peerId: data.ID,
            publicKey: data.PublicKey,
            agentVersion: data.AgentVersion,
            protocolVersion: data.ProtocolVersion,
            addresses: data.Addresses || [],
        }
    }

    /**
     * Fetch connected peer count
     */
    private async fetchPeerCount(): Promise<number> {
        const response = await this.apiRequest("/api/v0/swarm/peers", "POST")
        const data = await response.json()
        return data.Peers?.length ?? 0
    }

    /**
     * Make a request to the Kubo HTTP API
     *
     * @param endpoint - API endpoint path
     * @param method - HTTP method
     * @param body - Optional request body
     * @returns Response object
     */
    private async apiRequest(
        endpoint: string,
        method = "POST",
        body?: BodyInit,
    ): Promise<Response> {
        const url = `${this.apiUrl}${endpoint}`
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), this.timeout)

        try {
            this.log(`API Request: ${method} ${endpoint}`)

            const response = await fetch(url, {
                method,
                body,
                signal: controller.signal,
                headers: {
                    // Kubo API doesn't require special headers for most operations
                },
            })

            if (!response.ok) {
                const errorText = await response.text().catch(() => "Unknown error")
                throw new IPFSAPIError(
                    `IPFS API error: ${response.status} ${response.statusText}`,
                    response.status,
                    errorText,
                )
            }

            return response
        } catch (error) {
            if (error instanceof IPFSAPIError) {
                throw error
            }

            if (error instanceof Error && error.name === "AbortError") {
                throw new IPFSTimeoutError(endpoint, this.timeout)
            }

            throw new IPFSConnectionError(
                `Failed to connect to IPFS API at ${url}`,
                error instanceof Error ? error : undefined,
            )
        } finally {
            clearTimeout(timeoutId)
        }
    }

    /**
     * Log message if debug mode is enabled
     */
    private log(message: string): void {
        if (this.debug) {
            console.log(`[IPFSManager] ${message}`)
        }
    }
}
