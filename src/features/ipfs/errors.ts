/**
 * IPFS Integration Errors for Demos Network
 *
 * Custom error classes for IPFS operations with clear error codes
 * and actionable messages.
 *
 * @fileoverview IPFS error definitions
 */

/**
 * Base error class for all IPFS-related errors
 */
export class IPFSError extends Error {
    public readonly code: string
    public readonly cause?: Error

    constructor(message: string, code: string, cause?: Error) {
        super(message)
        this.name = "IPFSError"
        this.code = code
        this.cause = cause
        Object.setPrototypeOf(this, IPFSError.prototype)
    }
}

/**
 * Error when IPFS node is not reachable
 */
export class IPFSConnectionError extends IPFSError {
    constructor(message: string, cause?: Error) {
        super(message, "IPFS_CONNECTION_ERROR", cause)
        this.name = "IPFSConnectionError"
        Object.setPrototypeOf(this, IPFSConnectionError.prototype)
    }
}

/**
 * Error when IPFS operation times out
 */
export class IPFSTimeoutError extends IPFSError {
    public readonly timeoutMs: number

    constructor(operation: string, timeoutMs: number, cause?: Error) {
        super(
            `IPFS operation '${operation}' timed out after ${timeoutMs}ms`,
            "IPFS_TIMEOUT_ERROR",
            cause,
        )
        this.name = "IPFSTimeoutError"
        this.timeoutMs = timeoutMs
        Object.setPrototypeOf(this, IPFSTimeoutError.prototype)
    }
}

/**
 * Error when content is not found
 */
export class IPFSNotFoundError extends IPFSError {
    public readonly cid: string

    constructor(cid: string, cause?: Error) {
        super(`Content not found for CID: ${cid}`, "IPFS_NOT_FOUND", cause)
        this.name = "IPFSNotFoundError"
        this.cid = cid
        Object.setPrototypeOf(this, IPFSNotFoundError.prototype)
    }
}

/**
 * Error when CID is invalid
 */
export class IPFSInvalidCIDError extends IPFSError {
    public readonly cid: string

    constructor(cid: string, cause?: Error) {
        super(`Invalid CID format: ${cid}`, "IPFS_INVALID_CID", cause)
        this.name = "IPFSInvalidCIDError"
        this.cid = cid
        Object.setPrototypeOf(this, IPFSInvalidCIDError.prototype)
    }
}

/**
 * Error when IPFS API returns an error response
 */
export class IPFSAPIError extends IPFSError {
    public readonly statusCode?: number
    public readonly apiMessage?: string

    constructor(message: string, statusCode?: number, apiMessage?: string, cause?: Error) {
        super(message, "IPFS_API_ERROR", cause)
        this.name = "IPFSAPIError"
        this.statusCode = statusCode
        this.apiMessage = apiMessage
        Object.setPrototypeOf(this, IPFSAPIError.prototype)
    }
}

/**
 * Error codes for quick reference
 */
export const IPFS_ERROR_CODES = {
    CONNECTION_ERROR: "IPFS_CONNECTION_ERROR",
    TIMEOUT_ERROR: "IPFS_TIMEOUT_ERROR",
    NOT_FOUND: "IPFS_NOT_FOUND",
    INVALID_CID: "IPFS_INVALID_CID",
    API_ERROR: "IPFS_API_ERROR",
} as const
