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

interface GetStorageProgramFieldTypeData {
    storageAddress?: unknown
    field?: unknown
    requesterAddress?: unknown
}

/**
 * Get the JSON type of a top-level field on a storage program.
 *
 * JSON-only: binary-encoded programs return 400 / INVALID_FIELD_TYPE.
 * Field-not-found returns 404 / FIELD_NOT_FOUND (matches the HTTP route at
 * features/storageprogram/routes.ts:513-578).
 * Returns null when the program is missing / soft-deleted (200/null).
 */
export default async function getStorageProgramFieldType(
    data: GetStorageProgramFieldTypeData,
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

        return rpc(200, { field, type: getValueType(obj[field]) })
    } catch (error) {
        log.error("[getStorageProgramFieldType] Error: " + error)
        return rpcInternalError(error)
    }
}
