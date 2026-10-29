import type { RPCResponse } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool"
import type Peer from "src/libs/peer/Peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import type { CommittedReport } from "../routines/committedBlock"
import {
    filterMempoolByNonce,
    filterMempoolByRefBlock,
    type FailedTranscation,
    type MempoolTransaction,
} from "../routines/mempoolFilters"
import { fetchLocks, type ReportedLock } from "./getLock"
import { type CommitLock, type LockInputs, lockAt } from "./lockStore"
import { committeePeers } from "./precommit"
import { closePrevotes, withLockMutex } from "./roundState"

/**
 * One block this attempt may prevote, with every set of inputs reported
 * for it: a member could serve a real proof of lock with inputs that do
 * not rebuild the block, so each is tried and the hash decides.
 */
export interface RebuildOption<P = Peer> {
    origin: "lock" | "pol"
    hash: string
    round: number
    variants: LockInputs[]
    /** Members that reported the block, to fetch missing transactions from. */
    sources: P[]
}

function sameInputs(a: LockInputs, b: LockInputs): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

function addVariant(variants: LockInputs[], inputs: LockInputs): void {
    if (!variants.some(v => sameInputs(v, inputs))) variants.push(inputs)
}

/**
 * Candidates in the order the attempt tries them (step 1 of a round).
 * Locked on X with proof-of-lock round p: a block whose proof of lock is
 * from a round above p, highest first, then X itself; a locked member
 * never falls back to a fresh block. Unlocked: the reported blocks by
 * round, highest first, and the caller forges a fresh block when none of
 * them can be rebuilt.
 */
export function chooseCandidates<P>(
    ownLock: CommitLock | null,
    reported: ReportedLock<P>[],
): RebuildOption<P>[] {
    const byHash = new Map<string, RebuildOption<P>>()
    for (const lock of reported) {
        const option = byHash.get(lock.hash)
        if (!option) {
            byHash.set(lock.hash, {
                origin: "pol",
                hash: lock.hash,
                round: lock.round,
                variants: [lock.inputs],
                sources: [lock.source],
            })
            continue
        }
        option.round = Math.max(option.round, lock.round)
        addVariant(option.variants, lock.inputs)
        if (!option.sources.includes(lock.source)) {
            option.sources.push(lock.source)
        }
    }
    const byRound = (a: RebuildOption<P>, b: RebuildOption<P>) =>
        b.round - a.round || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)

    if (!ownLock) return [...byHash.values()].sort(byRound)

    const above = [...byHash.values()]
        .filter(o => o.hash !== ownLock.hash && o.round > ownLock.round)
        .sort(byRound)
    const same = byHash.get(ownLock.hash)
    const own: RebuildOption<P> = {
        origin: "lock",
        hash: ownLock.hash,
        round: Math.max(ownLock.round, same?.round ?? 0),
        variants: [ownLock.inputs],
        sources: same ? [...same.sources] : [],
    }
    for (const v of same?.variants ?? []) addVariant(own.variants, v)
    return [...above, own]
}

export interface RetryCandidates {
    /** Whether our own lock binds this height: no fresh block then. */
    locked: CommitLock | null
    options: RebuildOption[]
    committed: CommittedReport[]
}

/**
 * Close the previous attempt's prevote and gather what decides this
 * attempt's candidate. The other members' locks are asked for only on a
 * retry or while our own lock binds the height: on a first attempt
 * nobody can hold a lock at it yet.
 */
export async function gatherRetryCandidates(
    height: number,
    retrying: boolean,
    committee: string[],
): Promise<RetryCandidates> {
    // Under the mutex, so no precommit for the previous attempt can be
    // signed once the candidate of this one is being chosen.
    await withLockMutex(() => closePrevotes())

    const genesisHash = getSharedState.genesisBlockHash
    if (!genesisHash) {
        throw new Error("genesis block hash is not loaded")
    }
    const locked = lockAt(getSharedState.identityFile, genesisHash, height)
    if (!retrying && !locked) {
        return { locked: null, options: [], committed: [] }
    }
    if (locked) {
        log.info(
            `[commitLock] Locked on ${locked.hash} at height ${height} (proof of lock round ${locked.round})`,
        )
    }

    const { locks, committed } = await fetchLocks(
        height,
        committee,
        committeePeers(committee),
    )
    return { locked, options: chooseCandidates(locked, locks), committed }
}

async function fetchMissingTransactions(
    hashes: string[],
    sources: Peer[],
): Promise<void> {
    for (const source of sources) {
        const have = new Set(
            (await Mempool.getTransactionsByHashes(hashes)).map(t => t.hash),
        )
        const missing = hashes.filter(h => !have.has(h))
        if (missing.length === 0) return
        // getTxsByHashes serves at most batchSyncTxLimit hashes per call, so
        // a large block is asked for in batches, as sync does.
        const batchSize = getSharedState.batchSyncTxSize
        for (let i = 0; i < missing.length; i += batchSize) {
            const batch = missing.slice(i, i + batchSize)
            let response: RPCResponse
            try {
                response = await source.call(
                    {
                        method: "nodeCall",
                        params: [
                            {
                                message: "getTxsByHashes",
                                data: { hashes: batch },
                                muid: null,
                            },
                        ],
                    },
                    false,
                )
            } catch (e) {
                log.warning(
                    `[commitLock] getTxsByHashes from ${source.identity} failed: ${e instanceof Error ? e.message : String(e)}`,
                )
                break
            }
            if (
                response?.result !== 200 ||
                !Array.isArray(response.response)
            ) {
                continue
            }
            const wanted = new Set(batch)
            const served = (response.response as MempoolTransaction[]).filter(
                tx => tx && wanted.has(tx.hash),
            )
            if (served.length === 0) continue
            // Admitted only through the mempool's own validation
            await Mempool.receive(served, false)
        }
    }
}

export interface RebuiltTransactions {
    txs: MempoolTransaction[]
    failedTxs: FailedTranscation[]
    nonce: Awaited<ReturnType<typeof filterMempoolByNonce>>
}

/**
 * The transactions of a locked or proof-of-lock block, in its order and
 * judged as the fresh path judges them. Null when one is unavailable or
 * the filters would leave one out: the block could not be rebuilt as it
 * was voted.
 */
export async function rebuildTransactions(
    height: number,
    inputs: LockInputs,
    sources: Peer[],
): Promise<RebuiltTransactions | null> {
    if (inputs.previousHash !== getSharedState.lastBlockHash) {
        log.warning(
            `[commitLock] Inputs for height ${height} extend ${inputs.previousHash}, not our head ${getSharedState.lastBlockHash}`,
        )
        return null
    }
    const hashes = inputs.orderedTransactions
    if (new Set(hashes).size !== hashes.length) return null
    if (hashes.length > 0) {
        await fetchMissingTransactions(hashes, sources)
    }

    const stored =
        hashes.length > 0 ? await Mempool.getTransactionsByHashes(hashes) : []
    const found = new Map(
        stored.map(t => [t.hash, t as unknown as MempoolTransaction]),
    )
    const ordered: MempoolTransaction[] = []
    for (const hash of hashes) {
        const tx = found.get(hash)
        if (!tx) {
            log.warning(
                `[commitLock] Transaction ${hash} of the block to rebuild at ${height} is unavailable`,
            )
            return null
        }
        tx.blockNumber = height
        ordered.push(tx)
    }

    const ref = filterMempoolByRefBlock(ordered, true)
    const nonce = await filterMempoolByNonce(ref.validTxs)
    const kept = nonce.validTxs.map(t => t.hash)
    if (
        kept.length !== hashes.length ||
        kept.some((h, i) => h !== hashes[i])
    ) {
        log.warning(
            `[commitLock] The block to rebuild at ${height} no longer passes the mempool filters`,
        )
        return null
    }
    return {
        txs: nonce.validTxs,
        failedTxs: [...ref.failedTxs, ...nonce.failedTxs],
        nonce,
    }
}
