import type { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import type Peer from "src/libs/peer/Peer"
import { emptyResponse } from "src/libs/network/server_rpc"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { getBoundCommittee } from "../routines/getShard"
import {
    COMMIT_POLL_TIMEOUT_MS,
    COMMITTED_HEIGHT_RESULT,
    type CommittedReport,
    committedHeightRefusal,
    readCommittedRefusal,
} from "../routines/committedBlock"
import { commitLockActive, isRound } from "./domain"
import { isLockInputs, type LockInputs, lockAt } from "./lockStore"
import { proofOfLock } from "./votes"

/** A lock as one member reported it, with its proof of lock verified. */
export interface ReportedLock<P = Peer> {
    hash: string
    round: number
    pol: Record<string, string>
    inputs: LockInputs
    source: P
}

function answer(result: number, extra: unknown): RPCResponse {
    const response = _.cloneDeep(emptyResponse)
    response.result = result
    response.response = getSharedState.publicKeyHex
    response.extra = extra
    return response
}

/**
 * A committee member retrying a height asks for our lock at it. Params:
 * [height]. The answer is the lock with its proof of lock and the inputs
 * that rebuild the block, or null; at a height we already committed it is
 * the committed block, as for a proposal.
 */
export async function manageGetLock(
    sender: string,
    params: unknown[],
): Promise<RPCResponse> {
    const height = params?.[0]
    if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 1) {
        return answer(400, "Malformed lock request")
    }
    const committed = await committedHeightRefusal(height)
    if (committed) return committed
    if (height !== getSharedState.lastBlockNumber + 1) {
        return answer(409, {
            message: "Not at this height",
            height: getSharedState.lastBlockNumber + 1,
        })
    }
    if (!commitLockActive(height)) {
        return answer(400, "commitLock is not active at this height")
    }

    let committee: string[]
    try {
        committee = await getBoundCommittee(height - 1)
    } catch (e) {
        log.error(
            `[commitLock] Could not resolve the bound committee of ${height}: ${e instanceof Error ? e.message : String(e)}`,
        )
        return answer(500, "Could not resolve the bound committee")
    }
    if (!committee.includes(sender)) {
        return answer(401, "Validator is not in the bound committee")
    }

    const genesisHash = getSharedState.genesisBlockHash
    if (!genesisHash) return answer(500, "Genesis block hash is not loaded")
    let lock
    try {
        lock = lockAt(getSharedState.identityFile, genesisHash, height)
    } catch (e) {
        log.error(
            `[commitLock] Cannot read our commit lock for ${sender}: ${e instanceof Error ? e.message : String(e)}`,
        )
        return answer(500, "Commit lock unreadable")
    }
    return answer(200, {
        lock: lock
            ? {
                  height: lock.height,
                  hash: lock.hash,
                  round: lock.round,
                  pol: lock.pol,
                  inputs: lock.inputs,
              }
            : null,
    })
}

/**
 * Check one getLock answer. Only a lock whose proof of lock verifies
 * against the committee is kept: a member cannot steer our candidate with
 * a lock it made up.
 */
export async function readLockReply<P extends { identity: string }>(
    response: RPCResponse,
    height: number,
    committee: string[],
    source: P,
): Promise<ReportedLock<P> | null> {
    if (response?.result !== 200) return null
    const lock = (response.extra as { lock?: unknown } | null)?.lock as {
        height?: unknown
        hash?: unknown
        round?: unknown
        pol?: unknown
        inputs?: unknown
    } | null
    if (!lock) return null
    if (
        lock.height !== height ||
        typeof lock.hash !== "string" ||
        lock.hash.length === 0 ||
        !isRound(lock.round) ||
        !isLockInputs(lock.inputs)
    ) {
        log.warning(
            `[commitLock] ${source.identity} reported a malformed lock at height ${height}`,
        )
        return null
    }
    const pol = await proofOfLock(
        height,
        lock.round,
        lock.hash,
        lock.pol,
        committee,
    )
    if (!pol) {
        log.warning(
            `[commitLock] ${source.identity} reported a lock on ${lock.hash} in round ${lock.round} without a valid proof of lock`,
        )
        return null
    }
    return {
        hash: lock.hash,
        round: lock.round,
        pol,
        inputs: lock.inputs,
        source,
    }
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${what} timed out after ${ms}ms`)),
            ms,
        )
    })
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Ask every other committee member for its lock at `height`, in parallel and
 * each bounded, since this sits in front of the retry's candidate.
 */
export async function fetchLocks(
    height: number,
    committee: string[],
    peers: Peer[],
    timeoutMs = COMMIT_POLL_TIMEOUT_MS,
): Promise<{ locks: ReportedLock[]; committed: CommittedReport[] }> {
    const locks: ReportedLock[] = []
    const committed: CommittedReport[] = []
    await Promise.all(
        peers.map(async peer => {
            let response: RPCResponse
            try {
                response = await withTimeout(
                    peer.call(
                        {
                            method: "consensus_routine",
                            params: [{ method: "getLock", params: [height] }],
                        },
                        true,
                    ),
                    timeoutMs,
                    `getLock(${height}) from ${peer.identity}`,
                )
            } catch (e) {
                log.debug(
                    `[commitLock] ${e instanceof Error ? e.message : String(e)}`,
                )
                return
            }
            if (response?.result === COMMITTED_HEIGHT_RESULT) {
                const hash = readCommittedRefusal(response, height)
                if (hash !== null) committed.push({ peer, hash })
                return
            }
            const lock = await readLockReply(response, height, committee, peer)
            if (lock) locks.push(lock)
        }),
    )
    log.info(
        `[commitLock] Locks at height ${height}: ${locks.map(l => `${l.source.identity}=${l.hash}@${l.round}`).join(", ") || "none"}` +
            (committed.length > 0 ? `; ${committed.length} member(s) report it committed` : ""),
    )
    return { locks, committed }
}
