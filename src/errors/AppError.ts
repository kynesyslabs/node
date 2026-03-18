/**
 * AppError - Base error class for the entire application.
 *
 * All custom errors should extend this class. Provides:
 * - Machine-readable error code
 * - Logger category mapping
 * - Severity classification
 * - Optional context metadata
 */

import type { LogCategory } from "src/utilities/tui/CategorizedLogger"
import { ErrorSeverity, type AppErrorOptions, type ErrorContext } from "./types"

export class AppError extends Error {
    public readonly code: string
    public readonly category: LogCategory
    public readonly severity: ErrorSeverity
    public readonly context?: ErrorContext

    constructor(message: string, options: AppErrorOptions) {
        super(message, { cause: options.cause })
        this.name = this.constructor.name
        this.code = options.code
        this.category = options.category
        this.severity = options.severity ?? ErrorSeverity.RECOVERABLE
        this.context = options.context
    }

    /**
     * Serialize error for logging or RPC responses
     */
    toJSON(): Record<string, unknown> {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            category: this.category,
            severity: this.severity,
            ...(this.context ? { context: this.context } : {}),
        }
    }
}
