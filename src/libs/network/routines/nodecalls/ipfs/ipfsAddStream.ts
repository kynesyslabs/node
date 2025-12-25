/**
 * IPFS Add Stream NodeCall Handler
 *
 * Adds content to IPFS using streaming for memory-efficient large file uploads.
 * Supports chunked transfer encoding and progress reporting.
 *
 * @fileoverview IPFS streaming add endpoint (Phase 8)
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"

// REVIEW: Streaming add endpoint for large file support

interface IpfsAddStreamData {
    /**
     * Content as base64 encoded chunks.
     * For streaming, caller sends multiple requests with sequential chunk indices.
     */
    chunk: string
    /** Chunk index (0-based) */
    chunkIndex: number
    /** Total number of chunks (set on first chunk) */
    totalChunks?: number
    /** Upload session ID (generated on first chunk, required for subsequent chunks) */
    sessionId?: string
    /** Optional filename (set on first chunk) */
    filename?: string
    /** If true, this is the final chunk and upload should be finalized */
    finalize?: boolean
}

interface IpfsAddStreamResult {
    success: boolean
    /** Session ID for subsequent chunks (returned on first chunk) */
    sessionId?: string
    /** CID of the uploaded content (returned on finalize) */
    cid?: string
    /** Total size in bytes (returned on finalize) */
    size?: number
    /** Chunk acknowledged index */
    chunkIndex?: number
    /** Error message if failed */
    error?: string
}

// In-memory upload sessions (for chunked upload coordination)
// In production, this could be backed by Redis or similar for multi-node support
const uploadSessions = new Map<
    string,
    {
        chunks: Buffer[]
        filename?: string
        totalChunks?: number
        createdAt: number
    }
>()

// Clean up stale sessions (older than 30 minutes)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000
setInterval(() => {
    const now = Date.now()
    for (const [sessionId, session] of uploadSessions.entries()) {
        if (now - session.createdAt > SESSION_TIMEOUT_MS) {
            uploadSessions.delete(sessionId)
            log.debug(`[IPFS] Cleaned up stale upload session: ${sessionId}`)
        }
    }
}, 60 * 1000) // Check every minute

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
    return `ipfs-upload-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
}

/**
 * Add content to IPFS using chunked streaming
 *
 * Usage pattern:
 * 1. First chunk: Send with chunkIndex=0, totalChunks, filename. Receive sessionId.
 * 2. Middle chunks: Send with chunkIndex, sessionId.
 * 3. Final chunk: Send with chunkIndex, sessionId, finalize=true. Receive CID.
 *
 * @param data - Chunk data with session management
 * @returns Session ID or CID depending on stage
 */
export default async function ipfsAddStream(data: IpfsAddStreamData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsAddStream request (chunk ${data?.chunkIndex})`)

    // Validate chunk data
    if (!data?.chunk) {
        return {
            result: 400,
            response: {
                success: false,
                error: "No chunk data provided",
            } satisfies IpfsAddStreamResult,
            require_reply: false,
            extra: null,
        }
    }

    if (typeof data.chunkIndex !== "number" || data.chunkIndex < 0) {
        return {
            result: 400,
            response: {
                success: false,
                error: "Invalid chunk index",
            } satisfies IpfsAddStreamResult,
            require_reply: false,
            extra: null,
        }
    }

    try {
        // Decode the base64 chunk
        const chunkBuffer = Buffer.from(data.chunk, "base64")

        // First chunk - create new session
        if (data.chunkIndex === 0) {
            const sessionId = generateSessionId()
            uploadSessions.set(sessionId, {
                chunks: [chunkBuffer],
                filename: data.filename,
                totalChunks: data.totalChunks,
                createdAt: Date.now(),
            })

            log.debug(`[IPFS] Started upload session: ${sessionId} (${chunkBuffer.length} bytes)`)

            // If single chunk and finalize, complete immediately
            if (data.finalize) {
                return await finalizeUpload(sessionId, chunkBuffer.length)
            }

            return {
                result: 200,
                response: {
                    success: true,
                    sessionId,
                    chunkIndex: 0,
                } satisfies IpfsAddStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        // Subsequent chunks - require session ID
        if (!data.sessionId) {
            return {
                result: 400,
                response: {
                    success: false,
                    error: "Session ID required for chunk index > 0",
                } satisfies IpfsAddStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        const session = uploadSessions.get(data.sessionId)
        if (!session) {
            return {
                result: 404,
                response: {
                    success: false,
                    error: "Upload session not found or expired",
                } satisfies IpfsAddStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        // Validate chunk order
        if (data.chunkIndex !== session.chunks.length) {
            return {
                result: 400,
                response: {
                    success: false,
                    error: `Expected chunk ${session.chunks.length}, received ${data.chunkIndex}`,
                } satisfies IpfsAddStreamResult,
                require_reply: false,
                extra: null,
            }
        }

        // Add chunk to session
        session.chunks.push(chunkBuffer)
        log.debug(
            `[IPFS] Added chunk ${data.chunkIndex} to session ${data.sessionId} (${chunkBuffer.length} bytes)`,
        )

        // Finalize if requested
        if (data.finalize) {
            const totalSize = session.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            return await finalizeUpload(data.sessionId, totalSize)
        }

        return {
            result: 200,
            response: {
                success: true,
                sessionId: data.sessionId,
                chunkIndex: data.chunkIndex,
            } satisfies IpfsAddStreamResult,
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] AddStream failed: ${error}`)
        return {
            result: 500,
            response: {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            } satisfies IpfsAddStreamResult,
            require_reply: false,
            extra: null,
        }
    }
}

/**
 * Finalize the upload session and add to IPFS
 */
async function finalizeUpload(sessionId: string, totalSize: number): Promise<RPCResponse> {
    const session = uploadSessions.get(sessionId)
    if (!session) {
        return {
            result: 404,
            response: {
                success: false,
                error: "Upload session not found",
            } satisfies IpfsAddStreamResult,
            require_reply: false,
            extra: null,
        }
    }

    try {
        const ipfs = await ensureIpfsManager()

        // Combine all chunks into a single buffer
        const fullContent = Buffer.concat(session.chunks)

        // Add to IPFS
        const cid = await ipfs.add(fullContent, session.filename)

        // Clean up session
        uploadSessions.delete(sessionId)

        log.debug(`[IPFS] Finalized upload session ${sessionId}: CID=${cid}, size=${totalSize}`)

        return {
            result: 200,
            response: {
                success: true,
                cid,
                size: totalSize,
            } satisfies IpfsAddStreamResult,
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        // Clean up session on error
        uploadSessions.delete(sessionId)

        log.error(`[IPFS] Finalize failed for session ${sessionId}: ${error}`)
        return {
            result: 500,
            response: {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            } satisfies IpfsAddStreamResult,
            require_reply: false,
            extra: null,
        }
    }
}
