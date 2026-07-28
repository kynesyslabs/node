import { Peer } from "@/libs/peer"
import log from "@/utilities/logger"
import Mempool from "@/libs/blockchain/mempool"
import Chain from "@/libs/blockchain/chain"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { MERGE_MEMPOOL_MAX_TXS_PER_PEER } from "@/utilities/constants"
import { contributePeerlist, getLocalPeerlistView } from "./peerlistMerge"

const PEER_CALL_TIMEOUT_MS = 10_000

function withTimeout(
    promise: Promise<RPCResponse>,
    ms: number,
    peer: Peer,
): Promise<RPCResponse> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<RPCResponse>(resolve => {
        timeoutId = setTimeout(() => {
            log.error(`[withTimeout] Peer ${peer.connection.string} timed out`)

            return resolve({
                result: 504,
                response: "mergeMempools peer timeout",
                require_reply: false,
                extra: peer.identity,
            })
        }, ms)
    })

    return Promise.race([
        promise.finally(() => clearTimeout(timeoutId)),
        timeoutPromise,
    ])
}

export async function mergeMempools(
    mempool: Transaction[],
    shard: Peer[],
    blockRef: number,
) {
    const now = Date.now()
    // INFO: if shard only contains us, skip network requests
    shard = shard.filter(peer => peer.identity !== getSharedState.publicKeyHex)
    // INFO: committee members we cannot resolve locally have no connection
    // string; they stay in the shard for quorum purposes but cannot be called
    const unreachable = shard.filter(peer => !peer.connection.string)
    if (unreachable.length > 0) {
        log.warning(
            `[mergeMempools] ${unreachable.length} committee member(s) not in the local peer table, skipping calls to them`,
        )
    }
    shard = shard.filter(peer => peer.connection.string)
    if (shard.length === 0) {
        return
    }

    const request: RPCRequest = {
        method: "mempool",
        params: [
            {
                txs: mempool,
                peerlist: getLocalPeerlistView(),
                blockRef,
            },
        ],
    }

    const promises = shard.map(peer => {
        log.only(
            `[mergeMempools] Merging mempool with ${peer.connection.string}`,
        )
        return withTimeout(
            peer.longCall(request, true, {
                sleepTime: 250,
                retries: 2,
            }),
            PEER_CALL_TIMEOUT_MS,
            peer,
        )
    })

    const settled = await Promise.allSettled(promises)

    // INFO: collect txs from successful responses, deduped by hash,
    // so we make a single Mempool.receive call instead of one per peer.
    const merged = new Map<string, Transaction>()
    // Peerlist contributions from exchanges that parsed cleanly, held back
    // until their transactions are actually admitted (see below).
    const pendingContributions: Array<{
        identity: string
        peerlist: unknown
        carried: string[]
    }> = []
    for (const [i, result] of settled.entries()) {
        const peer = shard[i]

        if (result.status === "rejected") {
            log.error(
                `[mergeMempools] longCall rejected for ${peer.connection.string}: ${result.reason}`,
            )
            continue
        }

        const response = result.value
        const payload = response.response as {
            txs: Transaction[]
            peerlist: string[]
        }
        // A failed exchange must not influence block content: peerlist
        // enters the hash-sensitive block.content.peerlist, so recording
        // it from a non-200 payload lets validators that saw different
        // failure bodies derive different candidate blocks.
        if (response.result !== 200) {
            log.error(
                `[mergeMempools] Non-200 from ${peer.connection.string}: ${JSON.stringify(response, null, 2)}`,
            )
            continue
        }

        const rawTxs = payload?.txs
        // Defensive: a peer's response must carry a tx array. A malformed/hostile
        // peer returning a non-array would otherwise throw on iteration and
        // abort the whole merge round.
        if (!Array.isArray(rawTxs)) {
            log.error(
                `[mergeMempools] Non-array tx payload from ${peer.connection.string}, skipping`,
            )
            continue
        }

        // Cap per-peer ingestion so one peer cannot push unbounded validation
        // work onto the consensus tick (audit H4). Truncation is logged — never
        // silently dropped — so an operator can see a peer hitting the cap.
        let txs = rawTxs
        if (txs.length > MERGE_MEMPOOL_MAX_TXS_PER_PEER) {
            log.warning(
                `[mergeMempools] Peer ${peer.connection.string} returned ${txs.length} txs; ` +
                    `capping at ${MERGE_MEMPOOL_MAX_TXS_PER_PEER} for this round`,
            )
            txs = txs.slice(0, MERGE_MEMPOOL_MAX_TXS_PER_PEER)
        }
        log.only(
            `[mergeMempools] Received ${txs.length} transactions from ${peer.connection.string}`,
        )
        // Track which hashes this peer carried so its contribution can be
        // judged on its OWN admission outcome, not the round's aggregate.
        const carried: string[] = []
        for (const tx of txs) {
            if (tx && typeof tx.hash === "string") {
                carried.push(tx.hash)
                if (!merged.has(tx.hash)) {
                    merged.set(tx.hash, tx)
                }
            }
        }

        // Stage the contribution rather than recording it now: the exchange
        // is not complete until the txs it carried are admitted locally
        // below. Recording here would let a failed Mempool.receive leave us
        // holding peerlists whose transactions we never took.
        pendingContributions.push({
            identity: peer.identity,
            peerlist: payload?.peerlist,
            carried,
        })
    }

    // An exchange that carried no transactions has nothing left to admit, so
    // it is already complete and its peerlist can be committed as-is.
    if (merged.size === 0) {
        commitPendingContributions(blockRef, pendingContributions)
        return
    }

    log.only(
        `[mergeMempools] Forwarding ${merged.size} unique txs to Mempool.receive`,
    )
    // Only once the txs are admitted locally is the exchange complete. If
    // this throws, the contributions are dropped with them, so we never
    // commit a peerlist for an exchange whose transactions we didn't take.
    await Mempool.receive(Array.from(merged.values()))

    // Mempool.receive reports success even when it silently drops invalid
    // txs or swallows an insert failure, so its return value cannot stand in
    // for per-peer admission. Read back what actually landed and hold each
    // contributor to its own transactions.
    const admitted = await getAdmittedHashes(blockRef, merged)
    commitPendingContributions(
        blockRef,
        pendingContributions.filter(contribution => {
            if (contribution.carried.length === 0) {
                return true
            }
            const landed = contribution.carried.some(hash => admitted.has(hash))
            if (!landed) {
                log.warning(
                    `[mergeMempools] Dropping peerlist contribution from ${contribution.identity}: ` +
                        `none of its ${contribution.carried.length} tx(s) were admitted locally`,
                )
            }
            return landed
        }),
    )
    const end = Date.now()
    log.only(
        `[mergeMempools] Time taken: ${(end - now) / 1000}s with ${shard.length} peers`,
    )
}

/**
 * Hashes from this round that are now genuinely held locally — either sitting
 * in the mempool or already recorded on chain.
 *
 * A tx that a peer sent us can legitimately be absent from the mempool because
 * it was already included in a block, so mempool presence alone would
 * under-report admission and wrongly drop honest contributors.
 *
 * Fails closed: if admission cannot be determined, nothing counts as admitted.
 */
async function getAdmittedHashes(
    blockRef: number,
    merged: Map<string, Transaction>,
): Promise<Set<string>> {
    const admitted = new Set<string>()
    try {
        const inMempool = await Mempool.getMempoolHashMap(blockRef)
        for (const hash of merged.keys()) {
            if (inMempool[hash]) {
                admitted.add(hash)
            }
        }

        const remaining = [...merged.keys()].filter(h => !admitted.has(h))
        if (remaining.length > 0) {
            const onChain = await Chain.getExistingTransactionHashes(remaining)
            for (const hash of onChain) {
                admitted.add(hash)
            }
        }
    } catch (e) {
        // Fail closed. Treating the round as admitted would commit peerlists
        // for transactions Mempool.receive may well have rejected, and peers
        // whose lookup succeeded would commit a different set — divergent
        // candidate block hashes. Dropping the contributions is the safe
        // direction: it only costs us this round's peerlist additions.
        log.error(
            `[mergeMempools] Could not verify tx admission, dropping all contributions for this round: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return new Set<string>()
    }
    return admitted
}

/**
 * Record peerlist contributions for exchanges that completed end to end.
 * Deferred to a single point so a partially-failed round commits none of
 * them: peerlist feeds the hash-sensitive block.content.peerlist, and a
 * node that kept contributions its peers dropped would derive a different
 * candidate block.
 */
function commitPendingContributions(
    blockRef: number,
    pending: Array<{ identity: string; peerlist: unknown; carried: string[] }>,
): void {
    for (const contribution of pending) {
        contributePeerlist(
            blockRef,
            contribution.identity,
            contribution.peerlist,
        )
    }
}
