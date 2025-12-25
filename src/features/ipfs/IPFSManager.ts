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
    IPFSNotFoundError,
    IPFSInvalidCIDError,
} from "./errors"
import log from "@/utilities/logger"
import {
    type IpfsManagerConfig,
    type IpfsNodeInfo,
    type IpfsHealthStatus,
    type AddStreamOptions,
    type GetStreamOptions,
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

        this.logDebug(`IPFSManager created with API URL: ${this.apiUrl}`)
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
            this.logDebug("IPFSManager already initialized")
            return
        }

        this.logDebug("Initializing IPFSManager...")

        try {
            // Verify connection by fetching node identity
            this.cachedNodeInfo = await this.fetchNodeInfo()
            this.initialized = true
            this.logDebug(`IPFSManager initialized. Node ID: ${this.cachedNodeInfo.peerId}`)
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
        this.logDebug("Shutting down IPFSManager...")
        this.initialized = false
        this.cachedNodeInfo = null
        this.lastHealthCheck = null
        this.logDebug("IPFSManager shutdown complete")
    }

    // =========================================================================
    // Content Operations
    // =========================================================================

    /**
     * Add content to IPFS and return the CID
     *
     * @param content - Content to add (Buffer, Uint8Array, or string)
     * @param filename - Optional filename for the content
     * @returns CID (Content Identifier) of the added content
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     * @throws {IPFSAPIError} If IPFS API returns an error
     */
    async add(content: Buffer | Uint8Array | string, filename?: string): Promise<string> {
        this.logDebug(`Adding content to IPFS (size: ${content.length} bytes)`)

        // Convert content to Blob for multipart form data
        // Use Uint8Array to ensure compatibility with BlobPart type
        const contentBuffer = typeof content === "string" ? Buffer.from(content) : content
        const blob = new Blob([new Uint8Array(contentBuffer)])

        // Create multipart form data
        const formData = new FormData()
        formData.append("file", blob, filename || "file")

        const response = await this.apiRequest("/api/v0/add", "POST", formData)
        const data = await response.json()

        const cid = data.Hash
        if (!cid) {
            throw new IPFSAPIError("IPFS add response missing Hash field", undefined, JSON.stringify(data))
        }

        this.logDebug(`Content added successfully. CID: ${cid}`)
        return cid
    }

    /**
     * Retrieve content from IPFS by CID
     *
     * @param cid - Content Identifier to retrieve
     * @returns Content as Buffer
     * @throws {IPFSInvalidCIDError} If CID format is invalid
     * @throws {IPFSNotFoundError} If content is not found
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     */
    async get(cid: string): Promise<Buffer> {
        this.validateCid(cid)
        this.logDebug(`Getting content from IPFS. CID: ${cid}`)

        try {
            const response = await this.apiRequest(`/api/v0/cat?arg=${encodeURIComponent(cid)}`, "POST")
            const arrayBuffer = await response.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            this.logDebug(`Content retrieved successfully (size: ${buffer.length} bytes)`)
            return buffer
        } catch (error) {
            // Check for not found errors from IPFS API
            if (error instanceof IPFSAPIError && error.apiMessage?.includes("not found")) {
                throw new IPFSNotFoundError(cid, error)
            }
            throw error
        }
    }

    /**
     * Pin content to local IPFS node
     *
     * Pinning ensures content is not garbage collected.
     *
     * @param cid - Content Identifier to pin
     * @throws {IPFSInvalidCIDError} If CID format is invalid
     * @throws {IPFSNotFoundError} If content is not found
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     */
    async pin(cid: string): Promise<void> {
        this.validateCid(cid)
        this.logDebug(`Pinning content. CID: ${cid}`)

        try {
            await this.apiRequest(`/api/v0/pin/add?arg=${encodeURIComponent(cid)}`, "POST")
            this.logDebug(`Content pinned successfully. CID: ${cid}`)
        } catch (error) {
            if (error instanceof IPFSAPIError && error.apiMessage?.includes("not found")) {
                throw new IPFSNotFoundError(cid, error)
            }
            throw error
        }
    }

    /**
     * Unpin content from local IPFS node
     *
     * Unpinned content may be garbage collected.
     *
     * @param cid - Content Identifier to unpin
     * @throws {IPFSInvalidCIDError} If CID format is invalid
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     */
    async unpin(cid: string): Promise<void> {
        this.validateCid(cid)
        this.logDebug(`Unpinning content. CID: ${cid}`)

        try {
            await this.apiRequest(`/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, "POST")
            this.logDebug(`Content unpinned successfully. CID: ${cid}`)
        } catch (error) {
            // If content is not pinned, that's okay - it's already unpinned
            if (error instanceof IPFSAPIError && error.apiMessage?.includes("not pinned")) {
                this.logDebug(`Content was not pinned. CID: ${cid}`)
                return
            }
            throw error
        }
    }

    /**
     * List all pinned content CIDs
     *
     * @returns Array of pinned CIDs
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     */
    async listPins(): Promise<string[]> {
        this.logDebug("Listing pinned content...")

        const response = await this.apiRequest("/api/v0/pin/ls?type=recursive", "POST")
        const data = await response.json()

        // Kubo returns { Keys: { [cid]: { Type: "recursive" } } }
        const keys = data.Keys || {}
        const cids = Object.keys(keys)

        this.logDebug(`Found ${cids.length} pinned items`)
        return cids
    }

    /**
     * Check if content is pinned
     *
     * @param cid - Content Identifier to check
     * @returns true if pinned, false otherwise
     * @throws {IPFSInvalidCIDError} If CID format is invalid
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     */
    async isPinned(cid: string): Promise<boolean> {
        this.validateCid(cid)
        this.logDebug(`Checking pin status. CID: ${cid}`)

        try {
            const response = await this.apiRequest(`/api/v0/pin/ls?arg=${encodeURIComponent(cid)}`, "POST")
            const data = await response.json()
            const isPinned = Boolean(data.Keys && Object.keys(data.Keys).length > 0)
            this.logDebug(`Pin status for ${cid}: ${isPinned}`)
            return isPinned
        } catch (error) {
            // If not found, it's not pinned
            if (error instanceof IPFSAPIError && error.apiMessage?.includes("not pinned")) {
                return false
            }
            throw error
        }
    }

    /**
     * Get the size of content by CID without downloading it
     *
     * @param cid - Content Identifier
     * @returns Size in bytes
     * @throws {IPFSInvalidCIDError} If CID format is invalid
     * @throws {IPFSNotFoundError} If content is not found
     */
    async getSize(cid: string): Promise<number> {
        this.validateCid(cid)
        this.logDebug(`Getting size for CID: ${cid}`)

        try {
            const response = await this.apiRequest(`/api/v0/object/stat?arg=${encodeURIComponent(cid)}`, "POST")
            const data = await response.json()
            const size = data.CumulativeSize || data.DataSize || 0
            this.logDebug(`Size for ${cid}: ${size} bytes`)
            return size
        } catch (error) {
            if (error instanceof IPFSAPIError && error.apiMessage?.includes("not found")) {
                throw new IPFSNotFoundError(cid, error)
            }
            throw error
        }
    }


    // =========================================================================
    // Streaming Operations (Phase 8)
    // =========================================================================

    /**
     * Add content to IPFS using streaming for memory efficiency
     *
     * Suitable for large files (1GB+) as content is never fully loaded into memory.
     * Uses chunked transfer encoding to the Kubo API.
     *
     * @param stream - ReadableStream of content to upload
     * @param options - Optional filename and progress callback
     * @returns CID (Content Identifier) of the added content
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     * @throws {IPFSAPIError} If IPFS API returns an error
     *
     * @example
     * ```typescript
     * import { createReadStream } from 'fs'
     * import { Readable } from 'stream'
     *
     * // From file
     * const fileStream = Readable.toWeb(createReadStream('large-file.zip'))
     * const cid = await ipfs.addStream(fileStream, {
     *   filename: 'large-file.zip',
     *   onProgress: (bytes) => console.log(`Uploaded ${bytes} bytes`)
     * })
     * ```
     */
    async addStream(
        stream: ReadableStream<Uint8Array>,
        options: AddStreamOptions = {},
    ): Promise<string> {
        const { filename, onProgress } = options
        this.logDebug(`Adding content via stream${filename ? ` (${filename})` : ""}`)

        // REVIEW: Streaming add implementation for large file support
        // Create a tracking stream that reports progress
        let bytesTransferred = 0
        const trackingStream = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                bytesTransferred += chunk.length
                if (onProgress) {
                    onProgress(bytesTransferred)
                }
                controller.enqueue(chunk)
            },
        })

        // Pipe through the tracking stream
        const trackedStream = stream.pipeThrough(trackingStream)

        // Create multipart form data with streaming body
        // Note: We need to use a custom approach since FormData doesn't support streaming
        const boundary = `----DemosIPFSBoundary${Date.now()}`
        const contentDisposition = filename
            ? `form-data; name="file"; filename="${filename}"`
            : "form-data; name=\"file\"; filename=\"file\""

        // Build the multipart header and footer
        const headerStr = `--${boundary}\r\nContent-Disposition: ${contentDisposition}\r\nContent-Type: application/octet-stream\r\n\r\n`
        const footerStr = `\r\n--${boundary}--\r\n`

        const encoder = new TextEncoder()
        const header = encoder.encode(headerStr)
        const footer = encoder.encode(footerStr)

        // Create a composite stream: header + content + footer
        const compositeStream = this.createCompositeStream(header, trackedStream, footer)

        const url = `${this.apiUrl}/api/v0/add`
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 10) // Extended timeout for large files

        try {
            this.logDebug("API Request: POST /api/v0/add (streaming)")

            const response = await fetch(url, {
                method: "POST",
                body: compositeStream,
                signal: controller.signal,
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                },
                // @ts-expect-error - Bun supports duplex: 'half' for streaming uploads
                duplex: "half",
            })

            if (!response.ok) {
                const errorText = await response.text().catch(() => "Unknown error")
                throw new IPFSAPIError(
                    `IPFS API error: ${response.status} ${response.statusText}`,
                    response.status,
                    errorText,
                )
            }

            const data = await response.json()
            const cid = data.Hash

            if (!cid) {
                throw new IPFSAPIError("IPFS add response missing Hash field", undefined, JSON.stringify(data))
            }

            this.logDebug(`Content added via stream. CID: ${cid}, Total bytes: ${bytesTransferred}`)
            return cid
        } catch (error) {
            if (error instanceof IPFSAPIError) {
                throw error
            }

            if (error instanceof Error && error.name === "AbortError") {
                throw new IPFSTimeoutError("/api/v0/add (streaming)", this.timeout * 10)
            }

            throw new IPFSConnectionError(
                `Failed to stream content to IPFS API at ${url}`,
                error instanceof Error ? error : undefined,
            )
        } finally {
            clearTimeout(timeoutId)
        }
    }

    /**
     * Retrieve content from IPFS as a stream for memory efficiency
     *
     * Suitable for large files (1GB+) as content is never fully loaded into memory.
     * Returns a ReadableStream that can be piped to a file or processed in chunks.
     *
     * @param cid - Content Identifier to retrieve
     * @param options - Optional progress callback
     * @returns ReadableStream of the content
     * @throws {IPFSInvalidCIDError} If CID format is invalid
     * @throws {IPFSNotFoundError} If content is not found
     * @throws {IPFSConnectionError} If unable to connect to IPFS node
     *
     * @example
     * ```typescript
     * import { createWriteStream } from 'fs'
     * import { Writable } from 'stream'
     *
     * const stream = await ipfs.getStream('QmExample...', {
     *   onProgress: (bytes) => console.log(`Downloaded ${bytes} bytes`)
     * })
     *
     * // Pipe to file
     * const writeStream = Writable.toWeb(createWriteStream('output.zip'))
     * await stream.pipeTo(writeStream)
     * ```
     */
    async getStream(
        cid: string,
        options: GetStreamOptions = {},
    ): Promise<ReadableStream<Uint8Array>> {
        this.validateCid(cid)
        const { onProgress } = options
        this.logDebug(`Getting content as stream. CID: ${cid}`)

        // REVIEW: Streaming get implementation for large file support
        const url = `${this.apiUrl}/api/v0/cat?arg=${encodeURIComponent(cid)}`
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 10) // Extended timeout for large files

        try {
            this.logDebug("API Request: POST /api/v0/cat (streaming)")

            const response = await fetch(url, {
                method: "POST",
                signal: controller.signal,
            })

            if (!response.ok) {
                const errorText = await response.text().catch(() => "Unknown error")

                if (errorText.includes("not found")) {
                    throw new IPFSNotFoundError(cid, new IPFSAPIError(
                        `IPFS API error: ${response.status}`,
                        response.status,
                        errorText,
                    ))
                }

                throw new IPFSAPIError(
                    `IPFS API error: ${response.status} ${response.statusText}`,
                    response.status,
                    errorText,
                )
            }

            if (!response.body) {
                throw new IPFSAPIError("IPFS cat response has no body", undefined, "No body in response")
            }

            // Clear the initial timeout - streaming will handle its own chunk timeouts
            clearTimeout(timeoutId)

            // If no progress callback, return the raw stream
            if (!onProgress) {
                this.logDebug(`Returning raw stream for CID: ${cid}`)
                return response.body
            }

            // Wrap in a tracking stream for progress reporting
            let bytesTransferred = 0
            const trackingStream = new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    bytesTransferred += chunk.length
                    onProgress(bytesTransferred)
                    controller.enqueue(chunk)
                },
            })

            this.logDebug(`Returning tracked stream for CID: ${cid}`)
            return response.body.pipeThrough(trackingStream)
        } catch (error) {
            clearTimeout(timeoutId)

            if (error instanceof IPFSAPIError || error instanceof IPFSNotFoundError) {
                throw error
            }

            if (error instanceof Error && error.name === "AbortError") {
                throw new IPFSTimeoutError(`/api/v0/cat?arg=${cid}`, this.timeout * 10)
            }

            throw new IPFSConnectionError(
                `Failed to stream content from IPFS API at ${url}`,
                error instanceof Error ? error : undefined,
            )
        }
    }

    /**
     * Create a composite ReadableStream from header, content, and footer
     *
     * Helper method for multipart streaming uploads.
     *
     * @param header - Header bytes (multipart boundary and headers)
     * @param content - Content stream
     * @param footer - Footer bytes (closing boundary)
     * @returns Composite ReadableStream
     */
    private createCompositeStream(
        header: Uint8Array,
        content: ReadableStream<Uint8Array>,
        footer: Uint8Array,
    ): ReadableStream<Uint8Array> {
        let headerSent = false
        let contentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
        let contentDone = false

        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                // First, send the header
                if (!headerSent) {
                    controller.enqueue(header)
                    headerSent = true
                    contentReader = content.getReader()
                    return
                }

                // Then, stream the content
                if (!contentDone && contentReader) {
                    const { done, value } = await contentReader.read()
                    if (done) {
                        contentDone = true
                        contentReader.releaseLock()
                    } else if (value) {
                        controller.enqueue(value)
                        return
                    }
                }

                // Finally, send the footer and close
                if (contentDone) {
                    controller.enqueue(footer)
                    controller.close()
                }
            },
            cancel() {
                if (contentReader) {
                    contentReader.releaseLock()
                }
            },
        })
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    /**
     * Validate CID format
     *
     * Basic validation - checks for common CID patterns (CIDv0 and CIDv1)
     * CIDv0: Qm... (46 characters, base58)
     * CIDv1: bafy... or bafk... (base32/base58)
     *
     * @param cid - CID to validate
     * @throws {IPFSInvalidCIDError} If CID format is invalid
     */
    private validateCid(cid: string): void {
        if (!cid || typeof cid !== "string") {
            throw new IPFSInvalidCIDError(cid || "(empty)")
        }

        // CIDv0 pattern (Qm followed by base58 characters)
        const cidV0Pattern = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/

        // CIDv1 patterns (bafy or bafk prefix with base32 characters)
        const cidV1Pattern = /^(bafy|bafk|bafz|bafb)[a-z2-7]{50,}$/i

        if (!cidV0Pattern.test(cid) && !cidV1Pattern.test(cid)) {
            throw new IPFSInvalidCIDError(cid)
        }
    }

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
            this.logDebug(`API Request: ${method} ${endpoint}`)

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
    private logDebug(message: string): void {
        if (this.debug) {
            log.debug(`[IPFSManager] ${message}`)
        }
    }
}
