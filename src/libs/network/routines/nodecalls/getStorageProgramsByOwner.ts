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
 * List storage programs owned by an address, ACL-filtered for the requester.
 *
 * Owner sees all their own programs. Other requesters see only programs they
 * have read access to (per checkReadPermission).
 *
 * Pagination: limit clamped to [1, 200] (default 100), offset >= 0 (default 0).
 * Mirrors the HTTP route at features/storageprogram/routes.ts:617-696, but
 * paginates the post-filter list (HTTP route currently does not paginate this
 * endpoint).
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

        const repository = await getStorageProgramRepository()
        const programs =
            await GCRStorageProgramRoutines.getStorageProgramsByOwner(
                owner,
                repository,
            )

        // Owner always sees all their own programs; others (including
        // anonymous) get ACL-filtered. Anonymous callers MUST NOT be treated
        // as owner — bypassing the filter would leak owner/restricted programs.
        const isOwnerRequest =
            requesterAddress !== undefined && requesterAddress === owner
        const accessiblePrograms = isOwnerRequest
            ? programs
            : programs.filter(p =>
                  GCRStorageProgramRoutines.checkReadPermission(
                      p,
                      requesterAddress,
                  ),
              )

        const paginated = accessiblePrograms.slice(offset, offset + limit)
        return rpc(200, paginated.map(toStorageProgramListItem))
    } catch (error) {
        log.error("[getStorageProgramsByOwner] Error:", error)
        return rpcInternalError(error)
    }
}
