import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { GCRStorageProgramRoutines } from "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
import {
    getStorageProgramRepository,
    rpc,
    rpcBadRequest,
    rpcInternalError,
    toStorageProgramListItem,
} from "./storageProgramShared"

interface GetStorageProgramsByOwnerData {
    owner?: unknown
    requesterAddress?: unknown
    limit?: unknown
    offset?: unknown
}

/**
 * List storage programs owned by an address, ACL-filtered for the requester
 * and paginated at the SQL layer.
 *
 * Owner sees all their own programs. Other requesters see only programs they
 * have read access to (per checkReadPermission).
 *
 * Pagination: limit clamped to [1, 200] (default 100), offset >= 0 (default 0).
 * The default will drop to 100 in a future release — callers that rely on
 * the implicit cap should pass an explicit `limit`.
 *
 * Always returns an array — never null.
 */
export default async function getStorageProgramsByOwner(
    data: GetStorageProgramsByOwnerData,
): Promise<RPCResponse> {
    try {
        if (typeof data?.owner !== "string" || data.owner.length === 0) {
            return rpcBadRequest("Missing or invalid 'owner' field")
        }
        const owner = data.owner

        const requesterAddress =
            typeof data?.requesterAddress === "string" &&
            data.requesterAddress.length > 0
                ? data.requesterAddress
                : undefined

        const rawLimit = typeof data?.limit === "number" ? data.limit : 100
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 200)
        const rawOffset = typeof data?.offset === "number" ? data.offset : 0
        const offset = Math.max(0, Math.floor(rawOffset))

        // SQL-level pagination: the routine applies LIMIT/OFFSET directly
        // and never materialises the full owner result set in memory. The
        // owner-fast-path (requesterAddress === owner) skips the jsonb ACL
        // predicate and uses the existing owner index.
        const repository = await getStorageProgramRepository()
        const accessiblePrograms =
            await GCRStorageProgramRoutines.getStorageProgramsByOwner(
                owner,
                repository,
                requesterAddress,
                { limit, offset },
            )

        return rpc(200, accessiblePrograms.map(toStorageProgramListItem))
    } catch (error) {
        log.error("[getStorageProgramsByOwner] Error:", error)
        return rpcInternalError(error)
    }
}
