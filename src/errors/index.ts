/**
 * Unified Error Handling Module
 *
 * Usage:
 *
 * 1. In new code — use tryCatch:
 *    const [result, error] = await tryCatch(fetchPeer(), "PEER")
 *    if (error) return
 *
 * 2. In existing catch blocks — use handleError:
 *    catch (e) { handleError(e, "NETWORK") }
 *
 * 3. In RPC endpoints — use toErrorResponse:
 *    catch (e) {
 *        const { status, body } = toErrorResponse(e, "NETWORK")
 *        return jsonResponse(body, status)
 *    }
 *
 * 4. Throw domain errors:
 *    throw new PeerError("Connection refused", { code: ErrorCode.PEER_DISCONNECTED })
 */

// Constants & Enums
export { ErrorCode } from "./codes"
export { ErrorSource } from "./sources"
export { ErrorSeverity, type AppErrorOptions, type ErrorContext } from "./types"

// Base class
export { AppError } from "./AppError"

// Domain errors
export {
    NetworkError,
    PeerError,
    ChainError,
    ConsensusError,
    SyncError,
    L2PSError,
    IdentityError,
    MCPError,
    TLSNotaryError,
    StorageError,
    MultichainError,
} from "./domain"

// Utilities
export { tryCatch, tryCatchSync, handleError, toErrorResponse } from "./handleError"
