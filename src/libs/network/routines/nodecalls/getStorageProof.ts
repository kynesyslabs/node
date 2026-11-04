import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { E_TIMEOUT, withTimeout } from "async-mutex"
import { countStorageProofRootMismatch } from "@/features/metrics/consensusMetrics"
import Chain from "src/libs/blockchain/chain"
import { proveStoragePrograms } from "src/libs/blockchain/finality/storageRoot"
import { oldestProvableBlock } from "src/libs/blockchain/finality/storageHistory"
import { isCommitmentHash } from "src/libs/blockchain/finality/commitments"
import log from "src/utilities/logger"
import {
    answer,
    blockBytes,
    failedRead,
    refusal,
    signedHeader,
    toBlockNumber,
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

const storageRootOf = (block: { content?: unknown }): unknown =>
    (block.content as { native_tables_hashes?: { native_storage_programs?: unknown } })
        ?.native_tables_hashes?.native_storage_programs

/**
 * Sparse Merkle proofs for up to 16 storage programs against the storage
 * root committed in block B (`blockNumber`, default this node's head T).
 * Blocks are forged before they execute, so that root covers the state
 * after block B - 1 (`asOfBlock`). `anchor` is block B with its certificate;
 * `anchorParent` is block B - 1, whose committed peerlist and validator set
 * name who may sign B.
 *
 * The table holds the state after T, so the leaves B committed are rebuilt
 * under the sync lock by undoing the logged writes of blocks B..T, and the
 * rebuilt root must equal B's before anything is served. B is served for
 * the last 64 blocks, the undo log's window. A program present carries its
 * record, which holds the hash of its data, never the data, so restricted
 * programs are served the same way; an absent one has `record: null` and a
 * non-membership path.
 *
 * 400 for anything but 1..16 address strings or a bad block number; 503
 * node_not_synced without a block; 404 not_found above the head; 404
 * no_storage_commitment when B commits no storage root; 410
 * history_unavailable below the window; 500 root_mismatch when the rebuilt
 * root is not B's (a gap in the undo log); 503 busy when the sync lock is
 * not free in time.
 */
export default async function getStorageProof(data: {
    storageAddresses?: unknown
    blockNumber?: unknown
}): Promise<RPCResponse> {
    const addresses = readAddresses(data?.storageAddresses)
    if (addresses === null) {
        return refusal(400, "invalid_storage_addresses", {
            maxAddresses: MAX_STORAGE_PROOF_ADDRESSES,
        })
    }
    const requested = data?.blockNumber ?? null
    const requestedNumber = requested === null ? null : toBlockNumber(requested)
    if (requested !== null && requestedNumber === null) {
        return refusal(400, "invalid_block_number")
    }

    try {
        return await (await syncLock()).runExclusive(async () => {
            const head = await Chain.getLastBlock()
            if (!head) return refusal(503, "node_not_synced")
            const number = requestedNumber ?? head.number
            if (number > head.number) {
                return refusal(404, "not_found", { blockNumber: number, head: head.number })
            }
            if (number < 1) {
                return refusal(404, "no_storage_commitment", { blockNumber: number, head: head.number })
            }
            const oldest = oldestProvableBlock(head.number)
            if (number < oldest) {
                return refusal(410, "history_unavailable", {
                    blockNumber: number,
                    head: head.number,
                    oldestBlock: oldest,
                })
            }

            const anchor = number === head.number ? head : await Chain.getBlockByNumber(number)
            if (!anchor) throw new Error(`block ${number} below the head is not stored`)
            const anchorRoot = storageRootOf(anchor)
            if (!isCommitmentHash(anchorRoot)) {
                return refusal(404, "no_storage_commitment", { blockNumber: number, head: head.number })
            }
            const parent = await Chain.getBlockByNumber(number - 1)
            if (!parent) {
                throw new Error(`block ${number - 1} below the head is not stored`)
            }

            const unique = [...new Set(addresses)]
            const proved = await proveStoragePrograms(unique, {
                fromBlock: number,
                toBlock: head.number,
            })
            if (proved.root !== anchorRoot) {
                countStorageProofRootMismatch()
                log.error(
                    `[getStorageProof] the table with blocks ${number}..${head.number} undone gives ${proved.root}, ` +
                        `block ${number} commits ${anchorRoot}: the storage undo log is incomplete or wrong`,
                )
                return refusal(500, "root_mismatch", { blockNumber: number, head: head.number })
            }
            const byAddress = new Map(proved.proofs.map(p => [p.storageAddress, p]))
            return answer({
                anchor: signedHeader(anchor),
                anchorParent: blockBytes(parent),
                asOfBlock: number - 1,
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
