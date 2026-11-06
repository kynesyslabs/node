import { Peer } from "@/libs/peer"
import log from "@/utilities/logger"
import Mempool from "@/libs/blockchain/mempool"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import {
    capMergeReply,
    splitMergeBatches,
} from "@/libs/blockchain/mempoolLimits"
import { MERGE_REPLY_MAX_PAGES } from "@/utilities/constants"
import { contributePeerlist, getLocalSyncObservations } from "./peerlistMerge"

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

    // A pool can be larger than one request is allowed to be (see
    // splitMergeBatches), and the receiver refuses an oversized request
    // before merging anything, so the pool goes out in bounded requests.
    const batches = splitMergeBatches(mempool)
    const buildRequest = (txs: Transaction[], after?: string): RPCRequest => ({
        method: "mempool",
        params: [
            {
                txs,
                peerlist: getLocalSyncObservations(blockRef),
                blockRef,
                ...(after === undefined ? {} : { after }),
            },
        ],
    })

    // One peer's requests go out in order and stop at the first failure;
    // the peers are reached in parallel.
    const exchange = async (
        peer: Peer,
    ): Promise<PromiseSettledResult<RPCResponse>[]> => {
        log.only(
            `[mergeMempools] Merging mempool with ${peer.connection.string} in ${batches.length} request(s)`,
        )
        const outcomes: PromiseSettledResult<RPCResponse>[] = []
        const call = async (request: RPCRequest) => {
            const [outcome] = await Promise.allSettled([
                withTimeout(
                    peer.longCall(request, true, {
                        sleepTime: 250,
                        retries: 2,
                    }),
                    PEER_CALL_TIMEOUT_MS,
                    peer,
                ),
            ])
            outcomes.push(outcome)
            return outcome.status === "fulfilled" &&
                outcome.value.result === 200
                ? outcome.value
                : null
        }
        let last: RPCResponse | null = null
        for (const batch of batches) {
            last = await call(buildRequest(batch))
            if (!last) return outcomes
        }
        // A pool larger than one reply holds txs other members merged into
        // it after its own requests went out; ask for the rest.
        for (let page = 1; page < MERGE_REPLY_MAX_PAGES && last; page++) {
            const reply = last.response as { txs?: unknown; more?: unknown }
            const txs = Array.isArray(reply?.txs) ? reply.txs : []
            const after = (txs[txs.length - 1] as { hash?: unknown })?.hash
            if (reply?.more !== true || typeof after !== "string") break
            last = await call(buildRequest([], after))
        }
        return outcomes
    }

    const perPeer = await Promise.all(shard.map(exchange))
    const settled = perPeer.flatMap((outcomes, i) =>
        outcomes.map(outcome => ({ peer: shard[i], outcome })),
    )

    // INFO: collect txs from successful responses, deduped by hash,
    // so we make a single Mempool.receive call instead of one per peer.
    const merged = new Map<string, Transaction>()
    for (const { peer, outcome: result } of settled) {
        if (result.status === "rejected") {
            log.error(
                `[mergeMempools] longCall rejected for ${peer.connection.string}: ${result.reason}`,
            )
            continue
        }

        const response = result.value
        const payload = response.response as {
            txs: Transaction[]
            peerlist: unknown
        }

        if (response.result !== 200) {
            log.error(
                `[mergeMempools] Non-200 from ${peer.connection.string}: ${JSON.stringify(response, null, 2)}`,
            )
            continue
        }

        // The peerlist contribution feeds the secretary's merge only, so it
        // is recorded independently of what happens to the transactions.
        contributePeerlist(blockRef, peer.identity, payload?.peerlist)

        const rawTxs = payload?.txs
        if (!Array.isArray(rawTxs)) {
            log.error(
                `[mergeMempools] Non-array tx payload from ${peer.connection.string}, skipping`,
            )
            continue
        }

        // An honest peer's reply already fits one request (capMergeReply on
        // its side); a longer one only bounds the work it can push onto the
        // round.
        const txs = capMergeReply(rawTxs)
        if (txs.length < rawTxs.length) {
            log.warning(
                `[mergeMempools] Peer ${peer.connection.string} returned ${rawTxs.length} txs; ` +
                    `taking the first ${txs.length} for this round`,
            )
        }

        log.only(
            `[mergeMempools] Received ${txs.length} transactions from ${peer.connection.string}`,
        )

        for (const tx of txs) {
            if (tx && typeof tx.hash === "string" && !merged.has(tx.hash)) {
                merged.set(tx.hash, tx)
            }
        }
    }

    if (merged.size === 0) {
        return
    }

    log.only(
        `[mergeMempools] Forwarding ${merged.size} unique txs to Mempool.receive`,
    )
    await Mempool.receive(Array.from(merged.values()))

    const end = Date.now()
    log.only(
        `[mergeMempools] Time taken: ${(end - now) / 1000}s with ${shard.length} peers`,
    )
}
