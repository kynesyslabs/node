import log from "src/utilities/logger"
import { Config } from "src/config"
import {
    ERROR_CODE_UNKNOWN_OPCODE,
    ERROR_CODE_SIGNING,
    ERROR_CODE_CONNECTION,
    ERROR_CODE_CONNECTION_TIMEOUT,
    ERROR_CODE_AUTHENTICATION,
    ERROR_CODE_POOL_CAPACITY,
    ERROR_CODE_INVALID_AUTH_BLOCK_FORMAT,
} from "../constants"

export class OmniProtocolError extends Error {
    constructor(message: string, public readonly code: number) {
        super(message)
        this.name = "OmniProtocolError"

        // REVIEW: OMNI_FATAL mode for testing - exit on any OmniProtocol error
        if (Config.getInstance().omni.fatal) {
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
        super(`Unknown OmniProtocol opcode: 0x${opcode.toString(16)}`, ERROR_CODE_UNKNOWN_OPCODE)
        this.name = "UnknownOpcodeError"
    }
}

export class SigningError extends OmniProtocolError {
    constructor(message: string, public readonly cause?: Error) {
        super(`Signing failed: ${message}`, ERROR_CODE_SIGNING)
        this.name = "SigningError"
    }
}

export class ConnectionError extends OmniProtocolError {
    constructor(message: string) {
        super(message, ERROR_CODE_CONNECTION)
        this.name = "ConnectionError"
    }
}

export class ConnectionTimeoutError extends OmniProtocolError {
    constructor(message: string) {
        super(message, ERROR_CODE_CONNECTION_TIMEOUT)
        this.name = "ConnectionTimeoutError"
    }
}

export class AuthenticationError extends OmniProtocolError {
    constructor(message: string) {
        super(message, ERROR_CODE_AUTHENTICATION)
        this.name = "AuthenticationError"
    }
}

export class PoolCapacityError extends OmniProtocolError {
    constructor(message: string) {
        super(message, ERROR_CODE_POOL_CAPACITY)
        this.name = "PoolCapacityError"
    }
}

export class InvalidAuthBlockFormatError extends OmniProtocolError {
    constructor(message: string) {
        super(message, ERROR_CODE_INVALID_AUTH_BLOCK_FORMAT)
        this.name = "InvalidAuthBlockFormatError"
    }
}
