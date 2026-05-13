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
 * Format an Error's stack frames for the cause chain.
 *
 * V8/Node `Error.stack` begins with `"<name>: <message>"` followed by
 * `at ...` frames. The caller already prints name + message explicitly,
 * so drop the header line here to avoid duplicating it (CR-3 on PR
 * #817). Returns 5 frames max, each prefixed with `indent`.
 */
function formatErrorFrames(err: Error, indent: string): string {
    const lines = (err.stack ?? "").split("\n")
    const start = lines[0]?.startsWith(`${err.name}:`) ? 1 : 0
    return lines
        .slice(start, start + 5)
        .map(l => indent + l)
        .join("\n")
}

/**
 * Render the `errors[]` siblings on an AggregateError. Extracted from
 * formatCauseChain to keep its cognitive complexity below 15 (Sonar
 * threshold). Bounded at 5 siblings; the rest are summarised so a
 * pathological chain can't flood the logger.
 */
function formatAggregateSiblings(
    siblings: readonly unknown[],
    indent: string,
    depth: number,
): string {
    const shown = siblings.slice(0, 5)
    let out = ""
    for (let i = 0; i < shown.length; i++) {
        out += `\n${indent}[error ${i + 1}/${siblings.length}]`
        out += formatCauseChain(shown[i], depth + 1)
    }
    if (siblings.length > shown.length) {
        out += `\n${indent}... ${siblings.length - shown.length} more`
    }
    return out
}

/**
 * Walk the error.cause chain and AggregateError.errors[] siblings so the
 * underlying failure (e.g. node:net ECONNREFUSED nested under an
 * AggregateError nested under a wrapper) is visible in the log. Without
 * this, top-line `[UNKNOWN_ERROR]` lines carry no diagnostic payload.
 * Bounded by depth + sibling caps so a malicious/cyclical chain can't
 * blow up the logger.
 */
function formatCauseChain(cause: unknown, depth = 0): string {
    if (cause === undefined || cause === null) return ""
    if (depth > 4) return ` | cause: <chain truncated>`

    const indent = "  ".repeat(depth + 1)

    if (cause instanceof Error) {
        const frames = formatErrorFrames(cause, indent)
        let out = ` | cause: ${cause.name}: ${cause.message}`
        if (frames) out += `\n${frames}`

        // AggregateError.errors[]: the actual TCP/DNS failures live
        // here, not on the wrapper.
        const siblings = (cause as { errors?: unknown }).errors
        if (Array.isArray(siblings) && siblings.length > 0) {
            out += formatAggregateSiblings(siblings, indent, depth)
        }

        // Nested `cause` chain (Node 16+).
        const nested = (cause as { cause?: unknown }).cause
        if (nested !== undefined && nested !== null) {
            out += formatCauseChain(nested, depth + 1)
        }
        return out
    }

    try {
        return ` | cause: ${JSON.stringify(cause)}`
    } catch {
        return ` | cause: ${String(cause)}`
    }
}

/**
 * Log an AppError using the CategorizedLogger.
 */
function logError(error: AppError): void {
    const prefix = `[${error.code}]`
    const contextStr = error.context
        ? ` ${JSON.stringify(error.context)}`
        : ""
    // Diagnostic surface for the underlying cause — without this the
    // top-line log shows just "[UNKNOWN_ERROR]  {source:main,fatal:true}"
    // with no message, no stack, no original error. The cause comes
    // through `normalizeError` as `error.cause` (a generic Error or any
    // thrown value). Print message + first 5 stack frames when present.
    const causeStr = formatCauseChain(
        (error as { cause?: unknown }).cause,
    )
    const fullMessage = `${prefix} ${error.message}${contextStr}${causeStr}`

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
