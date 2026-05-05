import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import {
    getAccessibleProgram,
    requireJsonObject,
    rpc,
    rpcInternalError,
} from "./storageProgramShared"

interface GetStorageProgramFieldsData {
    storageAddress?: unknown
    requesterAddress?: unknown
}

/**
 * Get all top-level field names of a JSON storage program.
 *
 * JSON-only: binary-encoded programs return 400 / INVALID_FIELD_TYPE.
 * Returns null when the program is missing / soft-deleted (200/null).
 */
export default async function getStorageProgramFields(
    data: GetStorageProgramFieldsData,
): Promise<RPCResponse> {
    try {
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

        const fields = Object.keys(program.data as Record<string, unknown>)
        return rpc(200, { fields, count: fields.length })
    } catch (error) {
        log.error("[getStorageProgramFields] Error: " + error)
        return rpcInternalError(error)
    }
}
