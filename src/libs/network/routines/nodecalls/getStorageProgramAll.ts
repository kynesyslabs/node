import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import {
    getAccessibleProgram,
    rpc,
    rpcInternalError,
    toStorageProgramData,
} from "./storageProgramShared"

interface GetStorageProgramAllData {
    storageAddress?: unknown
    requesterAddress?: unknown
}

/**
 * Read full storage program data by address.
 *
 * The SDK documents this as an "alias for getByAddress with full data" and
 * types the response as `StorageProgramData`, so we return the same shape as
 * `getStorageProgram` (Date fields converted to ISO 8601 strings).
 *
 * Returns 200/null when the program is missing / soft-deleted.
 * Enforces ACL via checkReadPermission.
 */
export default async function getStorageProgramAll(
    data: GetStorageProgramAllData,
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

        return rpc(200, toStorageProgramData(result.program!))
    } catch (error) {
        log.error("[getStorageProgramAll] Error:", error)
        return rpcInternalError(error)
    }
}
