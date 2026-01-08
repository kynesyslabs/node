/**
 * IPFS Get Stream NodeCall Handler
 *
 * Retrieves content from IPFS using streaming for memory-efficient large file downloads.
 * Supports chunked transfer encoding and progress reporting.
 *
 * @fileoverview IPFS streaming get endpoint (Phase 8)
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"
import { IPFSNotFoundError, IPFSInvalidCIDError, STREAM_CHUNK_SIZE } from "@/features/ipfs"

// REVIEW: Streaming get endpoint for large file support

interface IpfsGetStreamData {
    /** Content Identifier */
    cid: string
    /**
     * Chunk index to retrieve (0-based).
     * If not specified, returns metadata only (size, chunk count).
     */
    chunkIndex?: number
    /** Custom chunk size in bytes (default: 256KB) */
    chunkSize?: number
}

interface IpfsGetStreamResult {
    success: boolean
    cid: string
    /** Total content size in bytes */
    size?: number
    /** Total number of chunks (returned in metadata call) */
    totalChunks?: number
    /** Current chunk index */
    chunkIndex?: number
    /** Chunk data as base64 */
    chunk?: string
    /** Chunk size in bytes */
    chunkSize?: number
    /** If true, this is the last chunk */
    isLastChunk?: boolean
    /** Error message if failed */
    error?: string
}

// In-memory download sessions for chunked reading
// Caches content for chunk-by-chunk retrieval
const downloadSessions = new Map<
    string,
    {
        content: Buffer
        createdAt: number
        // REVIEW: Sliding window timestamp - updated on each chunk access
        lastAccessedAt: number
    }
>()

// REVIEW: Pending downloads to prevent race condition (M4 fix)
// Multiple concurrent requests for same CID will await the same promise
const pendingDownloads = new Map<string, Promise<Buffer>>()

// Clean up stale download sessions (older than 10 minutes since LAST ACCESS)
const DOWNLOAD_SESSION_TIMEOUT_MS = 10 * 60 * 1000
setInterval(() => {
    const now = Date.now()
    for (const [sessionKey, session] of downloadSessions.entries()) {
        // REVIEW: Use lastAccessedAt instead of createdAt for sliding window (M5 fix)
        if (now - session.lastAccessedAt > DOWNLOAD_SESSION_TIMEOUT_MS) {
            downloadSessions.delete(sessionKey)
            log.debug(`[IPFS] Cleaned up stale download session: ${sessionKey}`)
        }
    }
}, 60 * 1000) // Check every minute

/**
 * Get content from IPFS using chunked streaming
 *
 * Usage pattern:
 * 1. Metadata call: Request with cid only. Returns size and totalChunks.
 * 2. Chunk calls: Request with cid and chunkIndex. Returns chunk data.
 *
 * @param data - CID and optional chunk index
 * @returns Metadata or chunk data
 */
export default async function ipfsGetStream(data: IpfsGetStreamData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsGetStream request for CID: ${data?.cid}, chunk: ${data?.chunkIndex}`)

    if (!data?.cid) {
        return {
            result: 400,
            response: {
                success: false,
                cid: "",
                error: "No CID provided",
            } satisfies IpfsGetStreamResult,
            require_reply: false,
            extra: null,
        }
    }

    const chunkSize = data.chunkSize ?? STREAM_CHUNK_SIZE

    try {
        const ipfs = await ensureIpfsManager()

        // Metadata request - return size and chunk count
        if (typeof data.chunkIndex !== "number") {
            const size = await ipfs.getSize(data.cid)
            const totalChunks = Math.ceil(size / chunkSize)

            log.debug(`[IPFS] Metadata for CID ${data.cid}: ${size} bytes, ${totalChunks} chunks`)

            return {
                result: 200,
                response: {
                    success: true,
                    cid: data.cid,
                    size,
                    totalChunks,
                    chunkSize,
                } satisfies IpfsGetStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        // Chunk request - get or create download session
        const sessionKey = `${data.cid}-${chunkSize}`
        let session = downloadSessions.get(sessionKey)

        if (!session) {
            // REVIEW: Check for pending download to prevent race condition (M4 fix)
            let content: Buffer
            const pendingDownload = pendingDownloads.get(sessionKey)

            if (pendingDownload) {
                // Another request is already fetching this CID, wait for it
                log.debug(`[IPFS] Waiting for pending download for CID ${data.cid}`)
                content = await pendingDownload
            } else {
                // Start new download and track it
                const downloadPromise = ipfs.get(data.cid)
                pendingDownloads.set(sessionKey, downloadPromise)

                try {
                    content = await downloadPromise
                } finally {
                    pendingDownloads.delete(sessionKey)
                }
            }

            // Check again in case another request created the session while we waited
            session = downloadSessions.get(sessionKey)
            if (!session) {
                const now = Date.now()
                session = {
                    content,
                    createdAt: now,
                    lastAccessedAt: now,
                }
                downloadSessions.set(sessionKey, session)
                log.debug(`[IPFS] Created download session for CID ${data.cid} (${content.length} bytes)`)
            }
        }

        // REVIEW: Update lastAccessedAt on each chunk access (M5 sliding window fix)
        session.lastAccessedAt = Date.now()

        // Calculate chunk boundaries
        const totalChunks = Math.ceil(session.content.length / chunkSize)

        if (data.chunkIndex < 0 || data.chunkIndex >= totalChunks) {
            return {
                result: 400,
                response: {
                    success: false,
                    cid: data.cid,
                    error: `Invalid chunk index ${data.chunkIndex}. Valid range: 0-${totalChunks - 1}`,
                } satisfies IpfsGetStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        const start = data.chunkIndex * chunkSize
        const end = Math.min(start + chunkSize, session.content.length)
        const chunkData = session.content.subarray(start, end)
        const isLastChunk = data.chunkIndex === totalChunks - 1

        log.debug(
            `[IPFS] Serving chunk ${data.chunkIndex}/${totalChunks - 1} for CID ${data.cid} (${chunkData.length} bytes)`,
        )

        // Clean up session after last chunk
        if (isLastChunk) {
            downloadSessions.delete(sessionKey)
            log.debug(`[IPFS] Completed download session for CID ${data.cid}`)
        }

        return {
            result: 200,
            response: {
                success: true,
                cid: data.cid,
                size: session.content.length,
                totalChunks,
                chunkIndex: data.chunkIndex,
                chunk: chunkData.toString("base64"),
                chunkSize: chunkData.length,
                isLastChunk,
            } satisfies IpfsGetStreamResult,
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] GetStream failed for CID ${data.cid}: ${error}`)

        if (error instanceof IPFSNotFoundError) {
            return {
                result: 404,
                response: {
                    success: false,
                    cid: data.cid,
                    error: `Content not found for CID: ${data.cid}`,
                } satisfies IpfsGetStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        if (error instanceof IPFSInvalidCIDError) {
            return {
                result: 400,
                response: {
                    success: false,
                    cid: data.cid,
                    error: `Invalid CID format: ${data.cid}`,
                } satisfies IpfsGetStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        return {
            result: 500,
            response: {
                success: false,
                cid: data.cid,
                error: error instanceof Error ? error.message : "Unknown error",
            } satisfies IpfsGetStreamResult,
            require_reply: false,
            extra: null,
        }
    }
}
