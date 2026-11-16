import log from "src/utilities/logger"

export class OmniProtocolError extends Error {
    constructor(
        message: string,
        public readonly code: number,
    ) {
        super(message)
        this.name = "OmniProtocolError"

        // REVIEW: OMNI_FATAL mode for testing - exit on any OmniProtocol error
        if (process.env.OMNI_FATAL === "true") {
            log.error(
                `[OmniProtocol] OMNI_FATAL: ${
                    this.name
                } (code: 0x${code.toString(16)}): ${message}`,
            )
            process.exit(1)
        }
    }
}

export class UnknownOpcodeError extends OmniProtocolError {
    constructor(public readonly opcode: number) {
        super(`Unknown OmniProtocol opcode: 0x${opcode.toString(16)}`, 0xf000)
        this.name = "UnknownOpcodeError"
    }
}

export class SigningError extends OmniProtocolError {
    constructor(
        message: string,
        public readonly cause?: Error,
    ) {
        super(`Signing failed: ${message}`, 0xf001)
        this.name = "SigningError"
    }
}

export class ConnectionError extends OmniProtocolError {
    constructor(message: string) {
        super(message, 0xf002)
        this.name = "ConnectionError"
    }
}

export class ConnectionTimeoutError extends OmniProtocolError {
    constructor(message: string) {
        super(message, 0xf003)
        this.name = "ConnectionTimeoutError"
    }
}

// The answer did not come in time while the connection was up, or while a
// connect another call started was still running: the peer is slow, not
// unreachable over Omni, so callers must not fall back to HTTP for it.
export class RequestTimeoutError extends ConnectionTimeoutError {
    constructor(message: string) {
        super(message)
        this.name = "RequestTimeoutError"
    }
}

// An established connection went away with the request on it. The peer may
// already have acted on the request, so it must not be resent elsewhere.
export class ConnectionLostError extends ConnectionError {
    constructor(message: string) {
        super(message)
        this.name = "ConnectionLostError"
    }
}

export class AuthenticationError extends OmniProtocolError {
    constructor(message: string) {
        super(message, 0xf004)
        this.name = "AuthenticationError"
    }
}

export class PoolCapacityError extends OmniProtocolError {
    constructor(message: string) {
        super(message, 0xf005)
        this.name = "PoolCapacityError"
    }
}

export class InvalidAuthBlockFormatError extends OmniProtocolError {
    constructor(message: string) {
        super(message, 0xf006)
        this.name = "InvalidAuthBlockFormatError"
    }
}
