import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { STORAGE_HISTORY_BLOCKS } from "src/libs/blockchain/finality/storageHistory"
import {
    STORAGE_PROGRAM_FEE_PER_CHUNK,
    STORAGE_PROGRAM_MAX_SIZE_BYTES,
    STORAGE_PROGRAM_PRICING_CHUNK_BYTES,
} from "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
import { answer } from "./finalityShared"
import { MAX_STORAGE_PROOF_ADDRESSES } from "./getStorageProof"

/**
 * The limits a client sizes storage requests by: addresses per
 * getStorageProof, how many recent blocks a proof can anchor at, the largest
 * program, and the fee per started pricing chunk (a decimal string, since
 * fees are bigints).
 */
export default async function getStorageProgramLimits(): Promise<RPCResponse> {
    return answer({
        maxAddressesPerProof: MAX_STORAGE_PROOF_ADDRESSES,
        historyBlocks: STORAGE_HISTORY_BLOCKS,
        maxProgramSizeBytes: STORAGE_PROGRAM_MAX_SIZE_BYTES,
        pricingChunkBytes: STORAGE_PROGRAM_PRICING_CHUNK_BYTES,
        feePerChunk: STORAGE_PROGRAM_FEE_PER_CHUNK.toString(),
    })
}
