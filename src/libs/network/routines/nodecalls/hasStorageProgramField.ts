import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import {
    getAccessibleProgram,
    rpc,
    rpcBadRequest,
    rpcInternalError,
} from "./storageProgramShared"

interface HasStorageProgramFieldData {
    storageAddress?: unknown
    field?: unknown
    requesterAddress?: unknown
}

/**
 * Check whether a top-level field exists on a JSON storage program.
 *
 * JSON-only: for binary / non-object data we return `exists: false` rather
 * than 400, mirroring the HTTP route at features/storageprogram/routes.ts:464-510
 * (which treats non-object data as "no fields").
 *
 * Returns null when the program is missing / soft-deleted (200/null).
 */
export default async function hasStorageProgramField(
    data: HasStorageProgramFieldData,
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
        const isJsonObject =
            program.data &&
            typeof program.data === "object" &&
            !Array.isArray(program.data)
        const exists = isJsonObject
            ? field in (program.data as Record<string, unknown>)
            : false

        return rpc(200, { field, exists })
    } catch (error) {
        log.error("[hasStorageProgramField] Error:", error)
        return rpcInternalError(error)
    }
}
