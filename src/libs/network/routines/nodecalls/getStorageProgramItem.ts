import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import {
    getAccessibleProgram,
    requireJsonObject,
    rpc,
    rpcBadRequest,
    rpcInternalError,
} from "./storageProgramShared"

interface GetStorageProgramItemData {
    storageAddress?: unknown
    field?: unknown
    index?: unknown
    requesterAddress?: unknown
}

/**
 * Get an array element by index from a JSON storage program field.
 *
 * Supports negative indexing (-1 = last). JSON-only.
 * Returns null when the program is missing / soft-deleted (200/null).
 */
export default async function getStorageProgramItem(
    data: GetStorageProgramItemData,
): Promise<RPCResponse> {
    try {
        if (typeof data?.field !== "string" || data.field.length === 0) {
            return rpcBadRequest("Missing or invalid 'field' field")
        }
        const field = data.field

        if (typeof data?.index !== "number" || !Number.isFinite(data.index)) {
            return rpcBadRequest("Missing or invalid 'index' field")
        }
        const rawIndex = Math.trunc(data.index)

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

        const arr = obj[field]
        if (!Array.isArray(arr)) {
            return rpc(400, {
                error: `Field is not an array: ${field}`,
                errorCode: "INVALID_FIELD_TYPE",
            })
        }

        // Resolve negative indexing.
        const resolvedIndex = rawIndex < 0 ? arr.length + rawIndex : rawIndex
        if (resolvedIndex < 0 || resolvedIndex >= arr.length) {
            return rpc(400, {
                error: `Index out of bounds: ${rawIndex} (array length: ${arr.length})`,
                errorCode: "INDEX_OUT_OF_BOUNDS",
            })
        }

        return rpc(200, {
            field,
            index: resolvedIndex,
            value: arr[resolvedIndex],
            arrayLength: arr.length,
        })
    } catch (error) {
        log.error("[getStorageProgramItem] Error:", error)
        return rpcInternalError(error)
    }
}
