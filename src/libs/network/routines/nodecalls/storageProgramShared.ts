import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Datasource from "src/model/datasource"
import { GCRStorageProgram } from "src/model/entities/GCRv2/GCR_StorageProgram"
import { GCRStorageProgramRoutines } from "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
import log from "src/utilities/logger"

export type StorageFieldType =
    | "string"
    | "number"
    | "boolean"
    | "array"
    | "object"
    | "null"
    | "undefined"

/**
 * Build a populated RPCResponse envelope.
 */
export function rpc(
    result: number,
    response: unknown,
    extra: unknown = "",
): RPCResponse {
    return {
        result,
        response,
        extra: extra as any,
        require_reply: false,
    }
}

/**
 * Standard 200-with-null response (used for not-found / soft-deleted single reads).
 * The SDK treats both 404 and `response === null` the same way.
 */
export function rpcNull(): RPCResponse {
    return rpc(200, null)
}

/**
 * Bad input (missing / invalid param).
 */
export function rpcBadRequest(error: string, errorCode = "INVALID_REQUEST"): RPCResponse {
    return rpc(400, { error, errorCode })
}

/**
 * Permission denied.
 */
export function rpcPermissionDenied(error = "Permission denied"): RPCResponse {
    return rpc(403, { error, errorCode: "PERMISSION_DENIED" })
}

/**
 * Internal error.
 */
export function rpcInternalError(error: unknown): RPCResponse {
    return rpc(
        500,
        { error: "INTERNAL_ERROR", errorCode: "INTERNAL_ERROR" },
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
}

/**
 * Resolve the JS type of a JSON value (matches SDK StorageFieldType).
 */
export function getValueType(value: unknown): StorageFieldType {
    if (value === undefined) return "undefined"
    if (value === null) return "null"
    if (Array.isArray(value)) return "array"
    if (typeof value === "string") return "string"
    if (typeof value === "number") return "number"
    if (typeof value === "boolean") return "boolean"
    return "object"
}

/**
 * Get the GCRStorageProgram repository.
 */
export async function getStorageProgramRepository() {
    const db = await Datasource.getInstance()
    return db.getDataSource().getRepository(GCRStorageProgram)
}

/**
 * Validate a storageAddress and fetch the program with ACL enforcement.
 *
 * Returns either:
 *   - { program } on success, or
 *   - { error: RPCResponse } when the address is invalid, the program is missing
 *     (or soft-deleted) — returns 200/null per the SDK contract — or read access
 *     is denied (403).
 */
export async function getAccessibleProgram(
    storageAddress: unknown,
    requesterAddress?: string,
): Promise<{ program?: GCRStorageProgram; error?: RPCResponse }> {
    if (typeof storageAddress !== "string" || storageAddress.length === 0) {
        return {
            error: rpcBadRequest("Missing or invalid 'storageAddress' field"),
        }
    }
    if (!storageAddress.startsWith("stor-")) {
        return {
            error: rpcBadRequest(
                "Invalid storage address format. Expected: stor-{hash}",
            ),
        }
    }

    const repository = await getStorageProgramRepository()
    const program = await GCRStorageProgramRoutines.getStorageProgram(
        storageAddress,
        repository,
    )
    if (!program) {
        // Not-found / soft-deleted -> SDK contract: return 200 + null.
        return { error: rpcNull() }
    }

    const hasReadAccess = GCRStorageProgramRoutines.checkReadPermission(
        program,
        requesterAddress,
    )
    if (!hasReadAccess) {
        return {
            error: rpcPermissionDenied(
                "Permission denied: You do not have read access to this storage program",
            ),
        }
    }

    return { program }
}

/**
 * Map a GCRStorageProgram entity to the SDK's StorageProgramData shape
 * (Date -> ISO 8601 string).
 */
export function toStorageProgramData(p: GCRStorageProgram) {
    return {
        storageAddress: p.storageAddress,
        owner: p.owner,
        programName: p.programName,
        encoding: p.encoding,
        data: p.data,
        metadata: p.metadata,
        storageLocation: p.storageLocation,
        sizeBytes: p.sizeBytes,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        createdByTx: p.createdByTx,
        lastModifiedByTx: p.lastModifiedByTx,
        interactionTxs: p.interactionTxs,
    }
}

/**
 * Map a GCRStorageProgram entity to the SDK's StorageProgramListItem shape.
 */
export function toStorageProgramListItem(p: GCRStorageProgram) {
    return {
        storageAddress: p.storageAddress,
        programName: p.programName,
        encoding: p.encoding,
        sizeBytes: p.sizeBytes,
        storageLocation: p.storageLocation,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
    }
}

/**
 * Validate the program holds JSON object data (granular ops are JSON-only).
 *
 * Returns an error RPCResponse on mismatch, or undefined when the data is a
 * plain JSON object.
 */
export function requireJsonObject(
    program: GCRStorageProgram,
): RPCResponse | undefined {
    if (
        !program.data ||
        typeof program.data !== "object" ||
        Array.isArray(program.data)
    ) {
        return rpc(400, {
            error: `Field operations are only available for JSON object data. Found: ${
                Array.isArray(program.data) ? "array" : typeof program.data
            }.`,
            errorCode: "INVALID_FIELD_TYPE",
        })
    }
    return undefined
}

/**
 * Input shape consumed by every JSON-object field-read handler.
 */
export interface FieldReadInput {
    storageAddress?: unknown
    field?: unknown
    requesterAddress?: unknown
}

/**
 * Context handed to a field-read reducer once all the envelope checks pass.
 */
export interface FieldReadContext {
    field: string
    value: unknown
    program: GCRStorageProgram
}

/**
 * Higher-order helper that handles the common envelope shared by the
 * "single JSON field read" RPC handlers (getStorageProgramValue,
 * getStorageProgramFieldType, ...).
 *
 * The envelope is identical across these handlers:
 *   1. validate `field` arg (non-empty string) -> 400 / INVALID_REQUEST
 *   2. coerce `requesterAddress` to string|undefined
 *   3. resolve the program with ACL enforcement (404/403/null already
 *      handled inside getAccessibleProgram)
 *   4. require JSON object data -> 400 / INVALID_FIELD_TYPE
 *   5. confirm the requested field exists on the object -> 404 /
 *      FIELD_NOT_FOUND
 *   6. delegate the response shape to the reducer
 *   7. catch + log + 500 / INTERNAL_ERROR
 *
 * The reducer is the only thing that varies between handlers, so we keep
 * it tiny: it receives the resolved {field, value, program} and returns
 * the RPCResponse the handler wants to ship.
 *
 * @param handlerName - Used for the log prefix (e.g. "getStorageProgramValue")
 * @param reducer - Builds the success RPCResponse from the resolved field
 */
export function withFieldRead(
    handlerName: string,
    reducer: (ctx: FieldReadContext) => RPCResponse,
): (data: FieldReadInput) => Promise<RPCResponse> {
    return async function fieldReadHandler(
        data: FieldReadInput,
    ): Promise<RPCResponse> {
        try {
            if (typeof data?.field !== "string" || data.field.length === 0) {
                return rpcBadRequest("Missing or invalid 'field' field")
            }
            const field = data.field

            const requesterAddress =
                typeof data?.requesterAddress === "string"
                    ? data.requesterAddress
                    : undefined

            const result = await getAccessibleProgram(
                data?.storageAddress,
                requesterAddress,
            )
            if (result.error) return result.error

            const program = result.program!
            const typeError = requireJsonObject(program)
            if (typeError) return typeError

            const obj = program.data as Record<string, unknown>
            if (!(field in obj)) {
                return rpc(404, {
                    error: `Field not found: ${field}`,
                    errorCode: "FIELD_NOT_FOUND",
                })
            }

            return reducer({ field, value: obj[field], program })
        } catch (error) {
            log.error(`[${handlerName}] Error:`, error)
            return rpcInternalError(error)
        }
    }
}
