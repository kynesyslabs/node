import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { E_TIMEOUT, withTimeout } from "async-mutex"
import Chain from "src/libs/blockchain/chain"
import { proveStoragePrograms } from "src/libs/blockchain/finality/storageRoot"
import { isCommitmentHash } from "src/libs/blockchain/finality/commitments"
import log from "src/utilities/logger"
import {
    answer,
    blockBytes,
    failedRead,
    refusal,
    signedHeader,
} from "./finalityShared"

export const MAX_STORAGE_PROOF_ADDRESSES = 16
const MAX_STORAGE_ADDRESS_LENGTH = 256

// A proof waits for the sync lock behind at most one block apply; past this
// the client is told to retry instead of holding a connection open.
const SYNC_LOCK_WAIT_MS = 5_000
const RETRY_AFTER_SECONDS = 2

async function syncLock() {
    // Loaded on first use: Sync pulls in the whole block pipeline.
    const { syncLock: lock } = await import("src/libs/blockchain/routines/Sync")
    return withTimeout(lock, SYNC_LOCK_WAIT_MS)
}

function readAddresses(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null
    if (value.length < 1 || value.length > MAX_STORAGE_PROOF_ADDRESSES) return null
    for (const address of value) {
        if (typeof address !== "string" || address.length === 0) return null
        if (address.length > MAX_STORAGE_ADDRESS_LENGTH) return null
    }
    return value as string[]
}

/**
 * Sparse Merkle proofs for up to 16 storage programs against the storage
 * root in this node's head block T. Blocks are forged before they execute,
 * so that root covers the state after block T - 1 (`asOfBlock`). `anchor`
 * is block T with its certificate; `anchorParent` is block T - 1, whose
 * committed peerlist and validator set name who may sign T.
 *
 * The table always holds the state after T, so the proofs are built under
 * the sync lock and served only when that state's root equals the anchor's:
 * true whenever block T wrote no storage program. Otherwise 503
 * state_ahead_of_anchor, and the client retries once a block without storage
 * writes lands. A program present carries its record, which holds the hash
 * of its data, never the data, so restricted programs are served the same
 * way; an absent one has `record: null` and a non-membership path.
 *
 * 400 for anything but 1..16 address strings; 503 node_not_synced without a
 * block; 404 no_storage_commitment when the head commits no storage root;
 * 503 busy when the sync lock is not free in time.
 */
export default async function getStorageProof(data: {
    storageAddresses?: unknown
}): Promise<RPCResponse> {
    const addresses = readAddresses(data?.storageAddresses)
    if (addresses === null) {
        return refusal(400, "invalid_storage_addresses", {
            maxAddresses: MAX_STORAGE_PROOF_ADDRESSES,
        })
    }

    try {
        return await (await syncLock()).runExclusive(async () => {
            const head = await Chain.getLastBlock()
            if (!head) return refusal(503, "node_not_synced")
            const anchorRoot = (
                head.content as { native_tables_hashes?: { native_storage_programs?: unknown } }
            )?.native_tables_hashes?.native_storage_programs
            if (head.number < 1 || !isCommitmentHash(anchorRoot)) {
                return refusal(404, "no_storage_commitment", { head: head.number })
            }
            const parent = await Chain.getBlockByNumber(head.number - 1)
            if (!parent) {
                throw new Error(`block ${head.number - 1} below the head is not stored`)
            }

            const unique = [...new Set(addresses)]
            const proved = await proveStoragePrograms(unique)
            if (proved.root !== anchorRoot) {
                return refusal(503, "state_ahead_of_anchor", {
                    head: head.number,
                    retryAfterSeconds: RETRY_AFTER_SECONDS,
                })
            }
            const byAddress = new Map(proved.proofs.map(p => [p.storageAddress, p]))
            return answer({
                anchor: signedHeader(head),
                anchorParent: blockBytes(parent),
                asOfBlock: head.number - 1,
                proofs: addresses.map(address => byAddress.get(address)),
            })
        })
    } catch (error) {
        if (error === E_TIMEOUT) {
            return refusal(503, "busy", { retryAfterSeconds: RETRY_AFTER_SECONDS })
        }
        log.error("[getStorageProof] Error building the proof:", error)
        return failedRead(error)
    }
}
