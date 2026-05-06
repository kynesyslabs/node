import getStorageProgram from "../routines/nodecalls/getStorageProgram"
import getStorageProgramAll from "../routines/nodecalls/getStorageProgramAll"
import getStorageProgramFieldType from "../routines/nodecalls/getStorageProgramFieldType"
import getStorageProgramFields from "../routines/nodecalls/getStorageProgramFields"
import getStorageProgramItem from "../routines/nodecalls/getStorageProgramItem"
import getStorageProgramValue from "../routines/nodecalls/getStorageProgramValue"
import getStorageProgramsByOwner from "../routines/nodecalls/getStorageProgramsByOwner"
import hasStorageProgramField from "../routines/nodecalls/hasStorageProgramField"
import searchStoragePrograms from "../routines/nodecalls/searchStoragePrograms"
import type { NodeCallHandler } from "./types"

/**
 * Read-side RPC handlers for the StorageProgram subsystem.
 *
 * Each handler returns its own RPCResponse (not the shared mutable
 * `response` argument) — the dispatcher's adapter just returns whatever
 * we hand back. ACL enforcement happens inside each handler via
 * GCRStorageProgramRoutines.checkReadPermission, with anonymous callers
 * limited to public programs.
 */
export const storageProgramHandlers: Record<string, NodeCallHandler> = {
    getStorageProgram: async data => {
        return await getStorageProgram(data)
    },
    getStorageProgramAll: async data => {
        return await getStorageProgramAll(data)
    },
    getStorageProgramFields: async data => {
        return await getStorageProgramFields(data)
    },
    getStorageProgramFieldType: async data => {
        return await getStorageProgramFieldType(data)
    },
    getStorageProgramItem: async data => {
        return await getStorageProgramItem(data)
    },
    getStorageProgramValue: async data => {
        return await getStorageProgramValue(data)
    },
    getStorageProgramsByOwner: async data => {
        return await getStorageProgramsByOwner(data)
    },
    hasStorageProgramField: async data => {
        return await hasStorageProgramField(data)
    },
    searchStoragePrograms: async data => {
        return await searchStoragePrograms(data)
    },
}
