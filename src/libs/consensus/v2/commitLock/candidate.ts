import type { RPCResponse } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool"
import {
    loadSigningRecord,
    type SigningRecord,
} from "src/libs/identity/signingRecord"
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
    /**
     * Why the height binds us although no lock file does: the signing
     * record holds a precommit at it or above. No fresh block then either.
     */
    bound: string | null
    options: RebuildOption[]
    committed: CommittedReport[]
}

/**
 * The candidates a precommit known only from the signing record allows.
 * The record holds the lost lock's block and round, but not the inputs
 * that rebuild it, so that block is taken only as a member reports it.
 * Above this height nothing is safe to prevote: our head is behind a
 * height we already voted at.
 */
export function chooseRecordBoundCandidates<P>(
    record: SigningRecord,
    height: number,
    reported: ReportedLock<P>[],
): RebuildOption<P>[] {
    if (record.height > height) return []
    const options = chooseCandidates(null, reported)
    const above = options.filter(
        o => o.hash !== record.hash && o.round > record.timestamp,
    )
    const same = options
        .filter(o => o.hash === record.hash)
        .map(o => ({ ...o, origin: "lock" as const }))
    return [...above, ...same]
}

/**
 * Close the previous attempt's prevote and gather what decides this
 * attempt's candidate. The other members' locks are asked for only on a
 * retry or while our own lock or a precommit in the signing record binds
 * the height: on a first attempt nobody can hold a lock at it yet.
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
    const identityFile = getSharedState.identityFile
    const locked = lockAt(identityFile, genesisHash, height)
    // Under the fork the record holds only precommits, each signed after
    // its lock was written: a record at this height without the lock
    // means the lock file was lost, and the lock it held still binds us.
    let record: SigningRecord | null = null
    if (!locked) {
        const last = loadSigningRecord(identityFile)
        if (last && last.genesisHash === genesisHash && last.height >= height) {
            record = last
        }
    }
    if (!retrying && !locked && !record) {
        return { locked: null, bound: null, options: [], committed: [] }
    }
    if (locked) {
        log.info(
            `[commitLock] Locked on ${locked.hash} at height ${height} (proof of lock round ${locked.round})`,
        )
    }
    let bound: string | null = null
    if (record) {
        bound =
            `the signing record holds a precommit for ${record.hash} at height ${record.height} (round ${record.timestamp}) ` +
            `but there is no commit lock for height ${height}`
        log.error(`[commitLock] ${bound}`)
    }

    const { locks, committed } = await fetchLocks(
        height,
        committee,
        committeePeers(committee),
    )
    const options = record
        ? chooseRecordBoundCandidates(record, height, locks)
        : chooseCandidates(locked, locks)
    return { locked, bound, options, committed }
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
