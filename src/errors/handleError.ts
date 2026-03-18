/**
 * Centralized error handling utilities.
 *
 * - tryCatch(): safe async wrapper returning [result, error] tuples
 * - handleError(): log + classify any unknown error
 * - toErrorResponse(): convert error to RPC-safe JSON response
 */

import { CategorizedLogger, type LogCategory } from "src/utilities/tui"
import { getErrorMessage } from "src/utilities/errorMessage"
import { AppError } from "./AppError"
import { ErrorSeverity, type ErrorContext } from "./types"
import { ErrorCode } from "./codes"

const logger = CategorizedLogger.getInstance()

// ─── tryCatch ────────────────────────────────────────────────────────

/**
 * Safe async wrapper. Instead of try/catch, use:
 *
 * ```ts
 * const [result, error] = await tryCatch(someAsyncFn())
 * if (error) { ... }
 * ```
 *
 * Automatically logs errors using the provided category.
 */
export async function tryCatch<T>(
    promise: Promise<T>,
    category: LogCategory = "CORE",
): Promise<[T, null] | [null, AppError]> {
    try {
        const result = await promise
        return [result, null]
    } catch (error) {
        const appError = normalizeError(error, category)
        logError(appError)
        return [null, appError]
    }
}

/**
 * Synchronous version of tryCatch for non-async operations.
 */
export function tryCatchSync<T>(
    fn: () => T,
    category: LogCategory = "CORE",
): [T, null] | [null, AppError] {
    try {
        const result = fn()
        return [result, null]
    } catch (error) {
        const appError = normalizeError(error, category)
        logError(appError)
        return [null, appError]
    }
}

// ─── handleError ─────────────────────────────────────────────────────

/**
 * Process any error: normalize it, log it, and return the AppError.
 *
 * Use this in existing catch blocks during migration:
 * ```ts
 * catch (error) {
 *     const appError = handleError(error, "NETWORK")
 *     // optionally do something with appError
 * }
 * ```
 */
export function handleError(
    error: unknown,
    category: LogCategory = "CORE",
    context?: ErrorContext,
): AppError {
    const appError = normalizeError(error, category, context)
    logError(appError)
    return appError
}

// ─── toErrorResponse ─────────────────────────────────────────────────

/**
 * HTTP status code mapping based on error code prefix.
 */
const ERROR_PREFIX_TO_STATUS: Record<string, number> = {
    VALIDATION_: 400,
    AUTH_: 401,
    FORBIDDEN_: 403,
    NOT_FOUND_: 404,
    RATE_LIMIT_: 429,
    TIMEOUT_: 408,
}

/**
 * Convert an error to a safe JSON response for RPC/HTTP endpoints.
 *
 * ```ts
 * catch (error) {
 *     const { status, body } = toErrorResponse(error, "NETWORK")
 *     return jsonResponse(body, status)
 * }
 * ```
 */
export function toErrorResponse(
    error: unknown,
    category: LogCategory = "NETWORK",
): { status: number; body: { error: string; code?: string } } {
    const appError = error instanceof AppError ? error : normalizeError(error, category)

    // Don't expose internal details to clients
    const isInternal =
        appError.severity === ErrorSeverity.CRITICAL ||
        appError.severity === ErrorSeverity.FATAL

    let status = 500
    for (const [prefix, httpCode] of Object.entries(ERROR_PREFIX_TO_STATUS)) {
        if (appError.code.startsWith(prefix)) {
            status = httpCode
            break
        }
    }

    return {
        status,
        body: {
            error: isInternal ? "Internal server error" : appError.message,
            code: isInternal ? undefined : appError.code,
        },
    }
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Map of known Error.name → ErrorCode for automatic classification.
 */
const ERROR_NAME_TO_CODE: Record<string, ErrorCode> = {
    TimeoutError: ErrorCode.TIMEOUT_EXCEEDED,
    AbortError: ErrorCode.OPERATION_ABORTED,
    BlockNotFoundError: ErrorCode.NOT_FOUND_BLOCK,
    PeerUnreachableError: ErrorCode.PEER_UNREACHABLE,
    NotInShardError: ErrorCode.PEER_NOT_IN_SHARD,
    ForgingEndedError: ErrorCode.CONSENSUS_FORGING_ENDED,
    BlockInvalidError: ErrorCode.VALIDATION_BLOCK_INVALID,
    TypeError: ErrorCode.VALIDATION_TYPE_ERROR,
    RangeError: ErrorCode.VALIDATION_RANGE_ERROR,
    SyntaxError: ErrorCode.VALIDATION_SYNTAX_ERROR,
}

/**
 * Error names that indicate critical severity.
 */
const CRITICAL_ERROR_NAMES = new Set([
    "StorageError",
    "ConsensusError",
    "DatabaseError",
])

/**
 * Convert any unknown error into an AppError.
 */
function normalizeError(
    error: unknown,
    category: LogCategory,
    context?: ErrorContext,
): AppError {
    // Already an AppError — just return it
    if (error instanceof AppError) {
        return error
    }

    const message = getErrorMessage(error)
    const severity = inferSeverity(error)

    return new AppError(message, {
        code: inferErrorCode(error),
        category,
        severity,
        cause: error,
        context,
    })
}

/**
 * Infer a machine-readable error code from an unknown error.
 */
function inferErrorCode(error: unknown): ErrorCode | string {
    if (error instanceof Error) {
        if (error.name in ERROR_NAME_TO_CODE) {
            return ERROR_NAME_TO_CODE[error.name]
        }

        // OmniProtocol errors have numeric codes
        if ("code" in error && typeof (error as { code: unknown }).code === "number") {
            return `OMNI_${((error as { code: number }).code).toString(16).toUpperCase()}`
        }
    }

    return ErrorCode.UNKNOWN_ERROR
}

/**
 * Infer severity from error type.
 */
function inferSeverity(error: unknown): ErrorSeverity {
    if (error instanceof Error) {
        if (CRITICAL_ERROR_NAMES.has(error.name)) return ErrorSeverity.CRITICAL
    }
    return ErrorSeverity.RECOVERABLE
}

/**
 * Log an AppError using the CategorizedLogger.
 */
function logError(error: AppError): void {
    const prefix = `[${error.code}]`
    const contextStr = error.context
        ? ` ${JSON.stringify(error.context)}`
        : ""
    const fullMessage = `${prefix} ${error.message}${contextStr}`

    switch (error.severity) {
        case ErrorSeverity.FATAL:
            logger.critical(error.category, fullMessage)
            break
        case ErrorSeverity.CRITICAL:
            logger.error(error.category, fullMessage)
            break
        case ErrorSeverity.RECOVERABLE:
            logger.warning(error.category, fullMessage)
            break
    }
}
