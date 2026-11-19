import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { STORAGE_HISTORY_BLOCKS } from "src/libs/blockchain/finality/storageHistory"
import {
    STORAGE_PROGRAM_FEE_PER_CHUNK,
    STORAGE_PROGRAM_MAX_JSON_DEPTH,
    STORAGE_PROGRAM_MAX_SIZE_BYTES,
    STORAGE_PROGRAM_PRICING_CHUNK_BYTES,
} from "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
import { answer } from "./finalityShared"
import { MAX_STORAGE_PROOF_ADDRESSES } from "./getStorageProof"

/** What `maxDataBytes` counts, as calculateDataSize measures it. */
export const STORAGE_DATA_MEASURED_OVER =
    "the program's data only, not its ACL or metadata: for json, the UTF-8 byte length of " +
    "JSON.stringify(data) as submitted (for a field or item write, of the whole data after the write); " +
    "for binary, the decoded length of the base64 data, floor(length * 3 / 4) minus its '=' padding characters"

// Neither limit sits behind a fork: every node enforces both at every
// height, genesis included. A change to them would ship behind one, and
// this would name its activation height.
const LIMITS_APPLY_FROM_BLOCK = 0

/**
 * The limits a client sizes storage requests by: addresses per
 * getStorageProof, how many recent blocks a proof can anchor at, the largest
 * program and what its size counts, the deepest JSON accepted (a top-level
 * object or array is depth 1), the fee per started pricing chunk (a decimal
 * string, since fees are bigints) and the first block the size and depth
 * limits apply at.
 *
 * `maxProgramSizeBytes` equals `maxDataBytes` and stays for the clients
 * that read it.
 */
export default function getStorageProgramLimits(): RPCResponse {
    return answer({
        maxAddressesPerProof: MAX_STORAGE_PROOF_ADDRESSES,
        historyBlocks: STORAGE_HISTORY_BLOCKS,
        maxDataBytes: STORAGE_PROGRAM_MAX_SIZE_BYTES,
        measuredOver: STORAGE_DATA_MEASURED_OVER,
        maxJsonDepth: STORAGE_PROGRAM_MAX_JSON_DEPTH,
        appliesFromBlock: LIMITS_APPLY_FROM_BLOCK,
        maxProgramSizeBytes: STORAGE_PROGRAM_MAX_SIZE_BYTES,
        pricingChunkBytes: STORAGE_PROGRAM_PRICING_CHUNK_BYTES,
        feePerChunk: STORAGE_PROGRAM_FEE_PER_CHUNK.toString(),
    })
}
