import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import {
    getAccessibleProgram,
    rpc,
    rpcInternalError,
    toStorageProgramData,
} from "./storageProgramShared"

interface GetStorageProgramData {
    storageAddress?: unknown
    auth?: unknown
}

/**
 * Read a single storage program by address.
 *
 * Returns 200/null when the program does not exist or is soft-deleted (the
 * SDK treats null and 404 the same way; we favour 200/null per the
 * cross-repo contract).
 *
 * Enforces ACL via checkReadPermission. Anonymous callers can read public
 * programs; restricted/owner programs require a signed `auth` envelope
 * proving control of an allowlisted address.
 */
export default async function getStorageProgram(
    data: GetStorageProgramData,
): Promise<RPCResponse> {
    try {
        const result = await getAccessibleProgram(
            data?.storageAddress,
            data?.auth,
        )
        if (result.error) {
            return result.error
        }

        return rpc(200, toStorageProgramData(result.program!))
    } catch (error) {
        log.error("[getStorageProgram] Error:", error)
        return rpcInternalError(error)
    }
}
