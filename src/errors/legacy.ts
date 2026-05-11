/**
 * Legacy exception classes — now backed by AppError.
 *
 * These maintain backward compatibility (constructor takes just a message string)
 * while gaining AppError features (code, category, severity, context).
 *
 * For new code, prefer using domain errors from "@/errors" directly.
 */

import { AppError } from "@/errors/AppError"
import { ErrorSeverity } from "@/errors/types"
import { ErrorCode } from "@/errors/codes"

/**
 * Thrown when a Waiter event times out
 */
export class TimeoutError extends AppError {
    constructor(message: string) {
        super(message, {
            code: ErrorCode.TIMEOUT_EXCEEDED,
            category: "CORE",
            severity: ErrorSeverity.RECOVERABLE,
        })
        this.name = "TimeoutError"
    }
}

/**
 * Thrown when a Waiter event is aborted
 */
export class AbortError extends AppError {
    constructor(message: string) {
        super(message, {
            code: ErrorCode.OPERATION_ABORTED,
            category: "CORE",
            severity: ErrorSeverity.RECOVERABLE,
        })
        this.name = "AbortError"
    }
}

export class BlockNotFoundError extends AppError {
    constructor(message: string) {
        super(message, {
            code: ErrorCode.NOT_FOUND_BLOCK,
            category: "CHAIN",
            severity: ErrorSeverity.RECOVERABLE,
        })
        this.name = "BlockNotFoundError"
    }
}

export class PeerUnreachableError extends AppError {
    constructor(message: string) {
        super(message, {
            code: ErrorCode.PEER_UNREACHABLE,
            category: "PEER",
            severity: ErrorSeverity.RECOVERABLE,
        })
        this.name = "PeerUnreachableError"
    }
}

export class NotInShardError extends AppError {
    constructor(message: string) {
        super(message, {
            code: ErrorCode.PEER_NOT_IN_SHARD,
            category: "PEER",
            severity: ErrorSeverity.RECOVERABLE,
        })
        this.name = "NotInShardError"
    }
}

export class ForgingEndedError extends AppError {
    constructor(message: string) {
        super(message, {
            code: ErrorCode.CONSENSUS_FORGING_ENDED,
            category: "CONSENSUS",
            severity: ErrorSeverity.RECOVERABLE,
        })
        this.name = "ForgingEndedError"
    }
}

export class BlockInvalidError extends AppError {
    constructor(message: string) {
        super(message, {
            code: ErrorCode.VALIDATION_BLOCK_INVALID,
            category: "CHAIN",
            severity: ErrorSeverity.RECOVERABLE,
        })
        this.name = "BlockInvalidError"
    }
}
