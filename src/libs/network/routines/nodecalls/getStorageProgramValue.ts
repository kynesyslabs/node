import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import {
    getAccessibleProgram,
    getValueType,
    requireJsonObject,
    rpc,
    rpcBadRequest,
    rpcInternalError,
} from "./storageProgramShared"

interface GetStorageProgramValueData {
    storageAddress?: unknown
    field?: unknown
    requesterAddress?: unknown
}

/**
 * Get a single field's value from a JSON storage program.
 *
 * JSON-only: binary-encoded programs return 400 / INVALID_FIELD_TYPE.
 * Field-not-found returns 404 / FIELD_NOT_FOUND (matches the HTTP route).
 * Returns null when the program is missing / soft-deleted (200/null).
 */
export default async function getStorageProgramValue(
    data: GetStorageProgramValueData,
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

        const value = obj[field]
        return rpc(200, { field, value, type: getValueType(value) })
    } catch (error) {
        log.error("[getStorageProgramValue] Error:", error)
        return rpcInternalError(error)
    }
}
