/**
 * Domain-specific error classes.
 *
 * Each class pre-sets its category and default severity,
 * so call sites only need to provide a message and error code.
 */

import { AppError } from "./AppError"
import { ErrorSeverity, type AppErrorOptions } from "./types"
import type { LogCategory } from "src/utilities/tui/CategorizedLogger"

// --- Type for domain error options (category is optional, defaults per domain) ---

type DomainErrorOptions = Omit<AppErrorOptions, "category"> &
    Partial<Pick<AppErrorOptions, "category">>

// --- Helper to reduce boilerplate ---

function domainError(
    defaultCategory: LogCategory,
    defaultSeverity: ErrorSeverity = ErrorSeverity.RECOVERABLE,
) {
    return class extends AppError {
        constructor(message: string, options: DomainErrorOptions) {
            super(message, {
                ...options,
                category: options.category ?? defaultCategory,
                severity: options.severity ?? defaultSeverity,
            })
            this.name = this.constructor.name
        }
    }
}

// --- Network & Peer Errors ---

export class NetworkError extends domainError("NETWORK") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "NetworkError"
    }
}

export class PeerError extends domainError("PEER") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "PeerError"
    }
}

// --- Blockchain & Consensus ---

export class ChainError extends domainError("CHAIN") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "ChainError"
    }
}

export class ConsensusError extends domainError("CONSENSUS", ErrorSeverity.CRITICAL) {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "ConsensusError"
    }
}

export class SyncError extends domainError("SYNC") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "SyncError"
    }
}

// --- L2PS ---

export class L2PSError extends domainError("CORE") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "L2PSError"
    }
}

// --- Identity ---

export class IdentityError extends domainError("IDENTITY") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "IdentityError"
    }
}

// --- MCP ---

export class MCPError extends domainError("MCP") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "MCPError"
    }
}

// --- TLSNotary ---

export class TLSNotaryError extends domainError("TLSN") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "TLSNotaryError"
    }
}

// --- Storage / Database ---

export class StorageError extends domainError("CORE", ErrorSeverity.CRITICAL) {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "StorageError"
    }
}

// --- Multichain ---

export class MultichainError extends domainError("MULTICHAIN") {
    constructor(message: string, options: DomainErrorOptions) {
        super(message, options)
        this.name = "MultichainError"
    }
}
