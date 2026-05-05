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

interface SearchStorageProgramsOptions {
    limit?: unknown
    offset?: unknown
    exactMatch?: unknown
    exact?: unknown
}

interface SearchStorageProgramsData {
    query?: unknown
    options?: SearchStorageProgramsOptions
    requesterAddress?: unknown
}

/**
 * Search storage programs by name (partial match by default, exact when
 * options.exactMatch is true). Results are ACL-filtered for the requester.
 *
 * Pagination: limit clamped to [1, 200] (default 100), offset >= 0 (default 0).
 * Matches the HTTP route at features/storageprogram/routes.ts:707-787.
 *
 * The SDK sends `options.exactMatch`; we also accept `options.exact` as a
 * fallback.
 *
 * Always returns an array — never null.
 */
export default async function searchStoragePrograms(
    data: SearchStorageProgramsData,
): Promise<RPCResponse> {
    try {
        if (
            typeof data?.query !== "string" ||
            data.query.trim().length === 0
        ) {
            return rpcBadRequest("Missing or invalid 'query' field")
        }
        const query = data.query.trim()

        const requesterAddress =
            typeof data?.requesterAddress === "string"
                ? data.requesterAddress
                : undefined

        const opts = data?.options ?? {}
        const rawLimit = typeof opts.limit === "number" ? opts.limit : 100
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 200)
        const rawOffset = typeof opts.offset === "number" ? opts.offset : 0
        const offset = Math.max(0, Math.floor(rawOffset))
        const exactMatch =
            typeof opts.exactMatch === "boolean"
                ? opts.exactMatch
                : typeof opts.exact === "boolean"
                  ? opts.exact
                  : false

        const repository = await getStorageProgramRepository()
        const programs =
            await GCRStorageProgramRoutines.searchStorageProgramsByName(
                query,
                repository,
                { limit, offset, exactMatch },
            )

        // Filter to programs the requester can read.
        const accessiblePrograms = programs.filter(p =>
            GCRStorageProgramRoutines.checkReadPermission(p, requesterAddress),
        )

        return rpc(200, accessiblePrograms.map(toStorageProgramListItem))
    } catch (error) {
        log.error("[searchStoragePrograms] Error: " + error)
        return rpcInternalError(error)
    }
}
