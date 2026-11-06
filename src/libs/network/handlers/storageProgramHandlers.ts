import getStorageProgram from "../routines/nodecalls/getStorageProgram"
import getStorageProgramAll from "../routines/nodecalls/getStorageProgramAll"
import getStorageProgramFieldType from "../routines/nodecalls/getStorageProgramFieldType"
import getStorageProgramFields from "../routines/nodecalls/getStorageProgramFields"
import getStorageProgramLimits from "../routines/nodecalls/getStorageProgramLimits"
import getStorageProgramItem from "../routines/nodecalls/getStorageProgramItem"
import getStorageProgramValue from "../routines/nodecalls/getStorageProgramValue"
import getStorageProof from "../routines/nodecalls/getStorageProof"
import getStorageProgramsByOwner from "../routines/nodecalls/getStorageProgramsByOwner"
import hasStorageProgramField from "../routines/nodecalls/hasStorageProgramField"
import searchStoragePrograms from "../routines/nodecalls/searchStoragePrograms"
import type { NodeCallHandler } from "./types"

/**
 * Read ACLs are checked against the verified sender only. A requesterAddress
 * in the request body is the caller's own claim, so it is replaced; without
 * a verified sender the read is anonymous.
 */
function asVerifiedRequester(data: unknown, sender: string) {
    const fields = data && typeof data === "object" ? data : {}
    return { ...fields, requesterAddress: sender || undefined }
}

/**
 * Read-side RPC handlers for the StorageProgram subsystem.
 *
 * Each handler returns its own RPCResponse (not the shared mutable
 * `response` argument) — the dispatcher's adapter just returns whatever
 * we hand back. ACL enforcement happens inside each handler via
 * GCRStorageProgramRoutines.checkReadPermission against the verified
 * sender, with anonymous callers limited to public programs.
 */
export const storageProgramHandlers: Record<string, NodeCallHandler> = {
    // No read check: a proof serves a program's record, which carries the
    // hash of its data and never the data, so every program is provable.
    getStorageProof: async data => {
        return await getStorageProof(data)
    },
    getStorageProgram: async (data, _response, sender) => {
        return await getStorageProgram(asVerifiedRequester(data, sender))
    },
    getStorageProgramAll: async (data, _response, sender) => {
        return await getStorageProgramAll(asVerifiedRequester(data, sender))
    },
    getStorageProgramFields: async (data, _response, sender) => {
        return await getStorageProgramFields(asVerifiedRequester(data, sender))
    },
    getStorageProgramFieldType: async (data, _response, sender) => {
        return await getStorageProgramFieldType(asVerifiedRequester(data, sender))
    },
    getStorageProgramLimits: async () => getStorageProgramLimits(),
    getStorageProgramItem: async (data, _response, sender) => {
        return await getStorageProgramItem(asVerifiedRequester(data, sender))
    },
    getStorageProgramValue: async (data, _response, sender) => {
        return await getStorageProgramValue(asVerifiedRequester(data, sender))
    },
    getStorageProgramsByOwner: async (data, _response, sender) => {
        return await getStorageProgramsByOwner(asVerifiedRequester(data, sender))
    },
    hasStorageProgramField: async (data, _response, sender) => {
        return await hasStorageProgramField(asVerifiedRequester(data, sender))
    },
    searchStoragePrograms: async (data, _response, sender) => {
        return await searchStoragePrograms(asVerifiedRequester(data, sender))
    },
}
