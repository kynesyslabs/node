/**
 * Error-related types and enums.
 */

import type { LogCategory } from "src/utilities/tui/CategorizedLogger"
import type { ErrorCode } from "./codes"
import type { ErrorSource } from "./sources"

/**
 * Error severity levels:
 * - RECOVERABLE: operation failed but node continues normally
 * - CRITICAL: something is seriously wrong, but node can still run
 * - FATAL: node should shut down
 */
export enum ErrorSeverity {
    RECOVERABLE = "recoverable",
    CRITICAL = "critical",
    FATAL = "fatal",
}

/**
 * Options for constructing an AppError.
 */
export interface AppErrorOptions {
    /** Machine-readable error code from ErrorCode constants */
    code: ErrorCode | string
    /** Logger category for this error */
    category: LogCategory
    /** How severe is this error */
    severity?: ErrorSeverity
    /** Original error that caused this one */
    cause?: unknown
    /** Additional context metadata */
    context?: ErrorContext
}

/**
 * Typed context for handleError() calls.
 */
export interface ErrorContext {
    /** Which subsystem/component produced the error */
    source?: ErrorSource | string
    /** Whether this error is fatal */
    fatal?: boolean
    /** Any additional metadata */
    [key: string]: unknown
}
