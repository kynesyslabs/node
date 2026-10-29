import type { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import type Block from "src/libs/blockchain/block"
import Chain from "src/libs/blockchain/chain"
import {
    syncBlock,
    syncLock,
    unreconciledGcrBlockNumber,
} from "src/libs/blockchain/routines/Sync"
import { verifyBlock } from "src/libs/blockchain/validation/verifyBlock"
import type Peer from "src/libs/peer/Peer"
import PeerManager from "src/libs/peer/PeerManager"
import { countConflictingBlock } from "src/features/metrics/consensusMetrics"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { creditVerifiedHeight } from "./networkAheadVeto"

/**
 * A member that already committed the height it is asked to vote on answers
 * with this code and the block it holds. A distinct code, rather than a plain
 * refusal, lets the proposer fetch that block instead of retrying the height
 * and building a second block with a quorum of its own.
 */
export const COMMITTED_HEIGHT_RESULT = 410
export const COMMITTED_HEIGHT_MESSAGE = "Height already committed"

/**
 * Bound for each peer queried about a height. Every query runs in parallel and
 * sits in front of a retry, so a dead member may only cost this much.
 */
export const COMMIT_POLL_TIMEOUT_MS = 3_000

/**
 * Bound on adopting while syncLock is held: every insert path and our own
 * round's commit wait on that lock. It cuts off a source still fetching its
 * transactions, but never one already applying, since stopping between its
 * GCR edits and its insert would leave the edits without the block.
 */
export const ADOPT_LOCK_BUDGET_MS = 3 * COMMIT_POLL_TIMEOUT_MS

/** One probe per peer per window: sync data and pushes arrive every block. */
export const HEIGHT_PROBE_INTERVAL_MS = 10_000

/**
 * Blocks one probe may verify and adopt in a row. Enough to close the gap a
 * short partition leaves; longer gaps are what fast sync is for.
 */
export const PROBE_CATCHUP_MAX_BLOCKS = 32

export interface CommittedReport {
    peer: Peer
    hash: string
}

export type AdoptOutcome =
    | "adopted"
    | "already-held"
    | "conflict"
    | "not-next"
    | "rejected"

/**
 * The refusal for a proposal at a height we have already committed, or null
 * when the height is still open here (or the proposer did not send one).
 */
export async function committedHeightRefusal(
    height: unknown,
): Promise<RPCResponse | null> {
    if (
        typeof height !== "number" ||
        !Number.isInteger(height) ||
        height < 1 ||
        height > getSharedState.lastBlockNumber
    ) {
        return null
    }

    const block = await Chain.getBlockByNumber(height)
    if (!block) return null

    log.warning(
        `[committedBlock] Refusing a proposal for block ${height}: already committed as ${block.hash}`,
    )
    return {
        result: COMMITTED_HEIGHT_RESULT,
        response: getSharedState.publicKeyHex,
        require_reply: false,
        extra: {
            message: COMMITTED_HEIGHT_MESSAGE,
            committedBlock: { number: block.number, hash: block.hash },
        },
    }
}

/** The committed hash a peer reported for `height`, if its reply is one. */
export function readCommittedRefusal(
    response: RPCResponse,
    height: number,
): string | null {
    if (response?.result !== COMMITTED_HEIGHT_RESULT) return null
    const committed = (
        response.extra as {
            committedBlock?: { number?: unknown; hash?: unknown }
        } | null
    )?.committedBlock
    if (
        !committed ||
        committed.number !== height ||
        typeof committed.hash !== "string" ||
        committed.hash.length === 0
    ) {
        return null
    }
    return committed.hash
}

function sleepReject(ms: number, what: string): Promise<never> {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    )
}

/** The block a peer holds at `height`, or null if it has none or is slow. */
export async function fetchBlockAt(
    peer: Peer,
    height: number,
    timeoutMs = COMMIT_POLL_TIMEOUT_MS,
): Promise<Block | null> {
    const request: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlocks",
                data: { start: height, limit: 1 },
                muid: null,
            },
        ],
    }
    try {
        const res = await Promise.race([
            peer.call(request, false),
            sleepReject(timeoutMs, `getBlocks(${height}) from ${peer.identity}`),
        ])
        if (res?.result !== 200 || !Array.isArray(res.response)) return null
        // getBlocks walks down from `start`, so a peer below the height
        // answers with older blocks rather than an error
        const block = (res.response as Block[]).find(b => b?.number === height)
        return block ?? null
    } catch (e) {
        log.debug(
            `[committedBlock] ${e instanceof Error ? e.message : String(e)}`,
        )
        return null
    }
}

const reportedConflicts = new Set<string>()

/**
 * Two quorum-certified blocks at one height cannot both be final. Switching
 * would mean rolling back a block this node committed, which nothing does
 * safely, so the node only makes the fork impossible to miss.
 */
export function reportConflictingBlock(
    height: number,
    ourHash: string,
    theirHash: string,
    peerId: string,
): void {
    const key = `${height}:${ourHash}:${theirHash}`
    if (reportedConflicts.has(key)) return
    reportedConflicts.add(key)
    countConflictingBlock()
    log.error(
        `[FORK] Conflicting committed block at height ${height}: we hold ${ourHash}, ` +
            `peer ${peerId} holds ${theirHash}; both carry a verified quorum. ` +
            "Not switching automatically: operator action required",
    )
}

/**
 * Verify a peer's block at a height where we hold `ours` and report it when
 * it is a second certified block. A block whose parent differs from ours
 * diverged lower down; it is logged, not judged here.
 */
export async function checkConflictingBlock(
    ours: { number: number; hash: string },
    theirs: Block,
    peerId: string,
): Promise<boolean> {
    if (!theirs || theirs.hash === ours.hash) return false

    const parent = await Chain.getBlockByNumber(ours.number - 1)
    if (!parent || theirs.content?.previousHash !== parent.hash) {
        log.warning(
            `[committedBlock] Peer ${peerId} holds ${theirs.hash} at ${ours.number} on a different parent; its chain diverges below this height`,
        )
        return false
    }

    const verdict = await verifyBlock(theirs as never)
    if (!verdict.valid) {
        log.warning(
            `[committedBlock] Peer ${peerId} holds an unverifiable block ${theirs.hash} at ${ours.number}: ${verdict.reason}`,
        )
        return false
    }

    reportConflictingBlock(ours.number, ours.hash, theirs.hash, peerId)
    return true
}

/**
 * Insert a block another member committed. The caller holds syncLock, the
 * lock every insert path takes, so a round that reaches its own commit
 * afterwards finds the height filled and ends on ForgingEndedError.
 *
 * Never throws: syncBlock throws on bodies it cannot verify (a source that
 * served the header and then dropped, or bad bodies), and that must reject
 * this source, not end the caller. syncBlock undoes the GCR edits of a block
 * whose apply or insert fails, and latches the node out of further applies
 * when that undo itself fails, which is the same guard fastSync relies on.
 */
export async function adoptCommittedBlock(
    block: Block,
    peer: Peer | undefined,
    fetchDeadline?: number,
): Promise<AdoptOutcome> {
    try {
        return await adoptCommittedBlockUnguarded(block, peer, fetchDeadline)
    } catch (e) {
        log.error(
            `[committedBlock] Adopting block ${block?.number} (${block?.hash}) from ${peer?.identity ?? "unknown peer"} failed: ${e instanceof Error ? e.message : String(e)}`,
        )
        return "rejected"
    }
}

async function adoptCommittedBlockUnguarded(
    block: Block,
    peer: Peer | undefined,
    fetchDeadline?: number,
): Promise<AdoptOutcome> {
    const ours = await Chain.getBlockByNumber(block.number)
    if (ours) {
        if (ours.hash === block.hash) return "already-held"
        return (await checkConflictingBlock(
            ours,
            block,
            peer?.identity ?? "unknown peer",
        ))
            ? "conflict"
            : "rejected"
    }

    if (block.number !== getSharedState.lastBlockNumber + 1) return "not-next"

    // Until one fast sync has succeeded, every fast sync runs without
    // syncLock, so holding the lock would not keep one from applying this
    // same block, whether it is running already or starts mid-apply
    if (getSharedState.fastSyncCount === 0) {
        log.info(
            `[committedBlock] Initial sync not complete; leaving block ${block.number} to it`,
        )
        return "rejected"
    }

    // Checked here so a foreign parent is a plain rejection: verifyBlock
    // treats it as an assertion failure under debug assertions
    if (block.content?.previousHash !== getSharedState.lastBlockHash) {
        log.error(
            `[committedBlock] Block ${block.number} (${block.hash}) from ${peer?.identity} does not extend our head ${getSharedState.lastBlockHash}`,
        )
        return "rejected"
    }

    if (!peer && (block.content?.ordered_transactions?.length ?? 0) > 0) {
        log.error(
            `[committedBlock] Block ${block.number} (${block.hash}) arrived from an unknown sender; cannot fetch its transactions`,
        )
        return "rejected"
    }

    const ok = await syncBlock(block, peer, fetchDeadline)
    if (!ok) return "rejected"
    log.info(
        `[committedBlock] Adopted block ${block.number} (${block.hash}) committed by ${peer?.identity}`,
    )
    return "adopted"
}

/**
 * Ask `peers` in parallel for their block at `height` and adopt the first
 * one that verifies. True when we now hold a block at that height that some
 * member committed, so the caller must not build its own.
 */
export async function adoptBlockFromPeers(
    height: number,
    peers: Peer[],
    context: string,
    timeoutMs = COMMIT_POLL_TIMEOUT_MS,
    budgetMs = ADOPT_LOCK_BUDGET_MS,
): Promise<boolean> {
    const selfId = getSharedState.publicKeyHex
    const targets = peers.filter(p => p && p.identity !== selfId)
    if (targets.length === 0) return false

    const answers = await Promise.all(
        targets.map(async peer => ({
            peer,
            block: await fetchBlockAt(peer, height, timeoutMs),
        })),
    )

    // Copies of one block share a hash but not their signatures, which the
    // hash does not cover: each source is verified on the copy it served, so
    // one copy short of a quorum cannot hide another source's full one.
    const variants = new Map<string, { block: Block; peer: Peer }[]>()
    for (const { peer, block } of answers) {
        if (!block) continue
        const variant = variants.get(block.hash)
        if (variant) variant.push({ block, peer })
        else variants.set(block.hash, [{ block, peer }])
    }
    if (variants.size === 0) {
        log.info(
            `[committedBlock] (${context}) No member holds block ${height}; proceeding`,
        )
        return false
    }

    const ordered = [...variants.values()].sort((a, b) => b.length - a.length)
    const release = await syncLock.acquire()
    const deadline = Date.now() + budgetMs
    try {
        sources: for (const variant of ordered) {
            for (const { block, peer: source } of variant) {
                // Every further source would be refused by sync anyway
                if (unreconciledGcrBlockNumber() !== null) {
                    log.error(
                        `[committedBlock] (${context}) GCR state drifted while adopting block ${height}; trying no further sources`,
                    )
                    break sources
                }
                if (Date.now() >= deadline) {
                    log.warning(
                        `[committedBlock] (${context}) No source of block ${height} adopted within ${budgetMs}ms; releasing the lock`,
                    )
                    break sources
                }
                const outcome = await adoptCommittedBlock(
                    block,
                    source,
                    deadline,
                )
                log.info(
                    `[committedBlock] (${context}) Block ${height} ${block.hash} from ${source.identity}: ${outcome}`,
                )
                if (outcome === "adopted" || outcome === "already-held") {
                    return true
                }
                if (outcome === "conflict" || outcome === "not-next") {
                    // The height is filled (or passed) here already
                    return getSharedState.lastBlockNumber >= height
                }
            }
        }
    } finally {
        release()
    }
    return getSharedState.lastBlockNumber >= height
}

/**
 * The height and members of the last round that ended without a block. A
 * member may have committed it while our tally failed; the retry asks them
 * first, because a fresh round at that height builds a different block that
 * could gather a second quorum.
 */
let lastFailedRound: { height: number; members: string[] } | null = null

export function recordFailedRound(height: number, members: string[]): void {
    if (members.length === 0) return
    lastFailedRound = { height, members: [...members] }
}

/** Whether the last round that ended without a block was at `height`. */
export function peekFailedRound(height: number): boolean {
    return lastFailedRound?.height === height
}

/**
 * Before a retry at `height`: true when a member of the failed round served
 * a verified block for it and we adopted it, so no new block may be built.
 */
export async function adoptBeforeRetry(height: number): Promise<boolean> {
    if (lastFailedRound?.height !== height) return false
    const { members } = lastFailedRound
    lastFailedRound = null
    const peerman = PeerManager.getInstance()
    // A member whose proposal reply timed out was marked offline, yet it may
    // be the one that committed: its known address is still worth asking.
    const offline = peerman.getOfflinePeers()
    const peers = members
        .map(id => peerman.getPeer(id) ?? offline[id])
        .filter((p): p is Peer => !!p)
    return await adoptBlockFromPeers(height, peers, "checkBeforeRetry")
}

const lastProbeAt = new Map<string, number>()

export function resetCommittedBlockState(): void {
    lastProbeAt.clear()
    reportedConflicts.clear()
    lastFailedRound = null
}

/**
 * Corroborate a height a peer reports instead of dropping it: a lagging node
 * otherwise never learns that blocks above its head exist. Rate-limited per
 * peer and run in the background, since it is triggered from request
 * handlers.
 */
export function scheduleHeightProbe(
    peer: Peer | undefined,
    claimedHeight: number,
    claimedHash?: string,
): void {
    if (!peer || !Number.isInteger(claimedHeight)) return
    if (peer.identity === getSharedState.publicKeyHex) return
    const now = Date.now()
    if ((lastProbeAt.get(peer.identity) ?? 0) > now - HEIGHT_PROBE_INTERVAL_MS)
        return
    lastProbeAt.set(peer.identity, now)
    void probePeerHeight(peer, claimedHeight, claimedHash).catch(e =>
        log.error(
            `[committedBlock] Height probe of ${peer.identity} failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
    )
}

/**
 * After a round at `height` found too few of its bound committee live: a
 * member counts as not live while its height is unknown to us, which is
 * also how a member that already certified `height` looks to a node that
 * missed the push. Only that committee can certify the block, so each of
 * its members is asked for it, through the rate-limited probe: one marked
 * offline is asked at its last known address, as in adoptBeforeRetry.
 */
export function probeCommitteeForHeight(
    height: number,
    committee: string[],
    live: Peer[],
): void {
    const peerman = PeerManager.getInstance()
    const offline = peerman.getOfflinePeers()
    const liveIds = new Set(live.map(p => p.identity.toLowerCase()))
    for (const identity of committee) {
        if (liveIds.has(identity.toLowerCase())) continue
        scheduleHeightProbe(
            peerman.getPeer(identity) ?? offline[identity],
            height,
        )
    }
}

/**
 * Above our head: adopt the peer's blocks one by one while each is a
 * quorum-verified child of our head, crediting only the heights verified.
 * At or below it: look for a second certified block at a height we hold.
 */
export async function probePeerHeight(
    peer: Peer,
    claimedHeight: number,
    claimedHash?: string,
): Promise<"credited" | "conflict" | "none"> {
    const head = getSharedState.lastBlockNumber

    if (claimedHeight <= head) {
        if (!claimedHash) return "none"
        const ours = await Chain.getBlockByNumber(claimedHeight)
        if (!ours || ours.hash === claimedHash) return "none"
        const theirs = await fetchBlockAt(peer, claimedHeight)
        if (!theirs) return "none"
        return (await checkConflictingBlock(ours, theirs, peer.identity))
            ? "conflict"
            : "none"
    }

    let verifiedUpTo = head
    for (let i = 0; i < PROBE_CATCHUP_MAX_BLOCKS; i++) {
        const tip = getSharedState.lastBlockNumber
        if (tip >= claimedHeight) break
        const tipHash = getSharedState.lastBlockHash
        const next = await fetchBlockAt(peer, tip + 1)
        if (!next) break

        if (next.content?.previousHash !== tipHash) {
            if (verifiedUpTo > head) break
            const [ours, theirs] = await Promise.all([
                Chain.getBlockByNumber(tip),
                fetchBlockAt(peer, tip),
            ])
            if (!ours || !theirs) return "none"
            return (await checkConflictingBlock(ours, theirs, peer.identity))
                ? "conflict"
                : "none"
        }

        const verdict = await verifyBlock(next as never)
        if (!verdict.valid) {
            log.warning(
                `[committedBlock] Peer ${peer.identity} claims height ${claimedHeight} but its block ${tip + 1} does not verify: ${verdict.reason}`,
            )
            break
        }

        // Only what was verified counts: a claimed height alone would let any
        // staked peer veto our forging through the network-ahead check
        verifiedUpTo = tip + 1
        creditVerifiedHeight(peer, verifiedUpTo)
        log.info(
            `[committedBlock] Peer ${peer.identity} is ahead: block ${verifiedUpTo} verified with quorum (claims ${claimedHeight})`,
        )

        // Taken now rather than on the next sync pass: if our own round for
        // this height is live, a later pass may come after it has built a
        // second block
        const release = await syncLock.acquire()
        let outcome: AdoptOutcome | "left-to-sync"
        try {
            outcome = getSharedState.inSyncLoop
                ? "left-to-sync"
                : await adoptCommittedBlock(next, peer)
        } finally {
            release()
        }
        log.info(
            `[committedBlock] Block ${verifiedUpTo} ${next.hash} from ${peer.identity}: ${outcome}`,
        )
        if (outcome !== "adopted") break
    }
    return verifiedUpTo > head ? "credited" : "none"
}
