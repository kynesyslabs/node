/**
 * Agreement on the fork schedule between this node and a peer.
 *
 * The schedule lives in each node's genesis file and is not part of what peers
 * compare when they pair (see normalizeGenesisForHash.ts), so a node that
 * missed a genesis edit would pair with everyone and then split from them at
 * the activation height. Each node publishes a digest of its whole schedule
 * through `getNetworkInfo`; this compares digests and, only when they differ,
 * names what differs.
 */

import { stableStringify } from "@/libs/blockchain/genesis/normalizeGenesisForHash"
import Hashing from "@/libs/crypto/hashing"

export interface ScheduleView {
    chainId: number | null | undefined
    /** activationHeight per fork the node reported; a fork it does not report is absent. */
    forks: Record<string, number | null>
    /** Absent on a node that predates the digest. */
    digest?: string
}

/**
 * UTF-16 code unit order, the same order `stableStringify` gives object keys.
 * `localeCompare` is deliberately not used for the digest: it varies with the
 * host's locale and ICU data, and two nodes must derive the same bytes.
 */
function byCodeUnit(a: string, b: string): number {
    if (a < b) return -1
    return a > b ? 1 : 0
}

export type ForkEntry = { activationHeight: number | null } & Record<string, unknown>
export type ForkConfigLike = Record<string, ForkEntry | undefined>

/**
 * Digest of everything about the schedule that consensus depends on: every
 * fork's activation height and payload, and the chain id. A fork's free-text
 * `description` is left out because it is a code constant that differs between
 * builds without meaning anything.
 */
export function forkScheduleDigest(
    forkConfig: ForkConfigLike,
    chainId: number | null,
): string {
    const forks: Record<string, unknown> = {}
    for (const name of Object.keys(forkConfig).sort(byCodeUnit)) {
        const entry = forkConfig[name]
        if (!entry) continue
        const { description: _description, ...consensus } = entry
        forks[name] = consensus
    }
    return Hashing.sha256(stableStringify({ chainId, forks }))
}

/** This node's view, from its loaded fork configuration. */
export function localScheduleView(
    forkConfig: ForkConfigLike,
    chainId: number | null,
): ScheduleView {
    const forks: Record<string, number | null> = {}
    for (const name of Object.keys(forkConfig)) {
        const entry = forkConfig[name]
        if (entry) forks[name] = entry.activationHeight
    }
    return { chainId, forks, digest: forkScheduleDigest(forkConfig, chainId) }
}

/** A peer's view from its `getNetworkInfo` answer, or null when the answer has no fork table. */
export function peerScheduleView(info: unknown): ScheduleView | null {
    if (info === null || typeof info !== "object") return null
    const { forks, chainId, forkScheduleDigest: digest } = info as {
        forks?: Record<string, { activationHeight?: number | null } | undefined>
        chainId?: number | null
        forkScheduleDigest?: string
    }
    if (!forks || typeof forks !== "object") return null
    const out: Record<string, number | null> = {}
    for (const name of Object.keys(forks)) {
        const entry = forks[name]
        if (entry?.activationHeight !== undefined) {
            out[name] = entry.activationHeight
        }
    }
    return { chainId, forks: out, digest }
}

export type ScheduleComparison =
    | { status: "agree" }
    /** The peer predates the digest: nothing to compare. */
    | { status: "skipped" }
    | { status: "mismatch"; lines: string[] }

/**
 * Compare two views by digest. Detail lines are only for the forks both sides
 * report: a peer on an older build says nothing about a fork it does not know.
 */
export function compareSchedules(
    ours: ScheduleView,
    theirs: ScheduleView,
): ScheduleComparison {
    if (theirs.digest === undefined) return { status: "skipped" }
    if (ours.digest === theirs.digest) return { status: "agree" }
    const lines = [`schedule digest: ours ${ours.digest}, theirs ${theirs.digest}`]
    for (const name of Object.keys(ours.forks).sort(byCodeUnit)) {
        if (!(name in theirs.forks)) continue
        if (ours.forks[name] !== theirs.forks[name]) {
            lines.push(
                `${name}: ours ${String(ours.forks[name])}, theirs ${String(theirs.forks[name])}`,
            )
        }
    }
    if (theirs.chainId !== undefined && ours.chainId !== theirs.chainId) {
        lines.push(`chainId: ours ${String(ours.chainId)}, theirs ${String(theirs.chainId)}`)
    }
    return { status: "mismatch", lines }
}

export interface SchedulePeer {
    // `any` so that `Peer.call(request: RPCRequest)` is assignable without this module importing it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: (request: any) => Promise<{ result?: number; response?: unknown } | null>
}

export type PeerScheduleCheck =
    | ScheduleComparison
    /** The peer answered "not ready" every time: it is still booting. */
    | { status: "not-ready" }
    | { status: "unreachable"; reason: string }

/**
 * Ask a peer for its schedule and compare. A peer that is still starting
 * answers 503 until it has loaded its genesis; that is not a mismatch, so it is
 * asked again a few times and then reported as not ready, to be checked later.
 */
export async function checkPeerSchedule(
    peer: SchedulePeer,
    ours: ScheduleView,
    options: { attempts?: number; sleepMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PeerScheduleCheck> {
    const attempts = options.attempts ?? 5
    const sleepMs = options.sleepMs ?? 2000
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let answer: Awaited<ReturnType<SchedulePeer["call"]>>
        try {
            answer = await peer.call({
                method: "nodeCall",
                params: [{ message: "getNetworkInfo" }],
            })
        } catch (error) {
            return {
                status: "unreachable",
                reason: error instanceof Error ? error.message : String(error),
            }
        }
        if (answer?.result === 503) {
            if (attempt < attempts) await sleep(sleepMs)
            continue
        }
        if (answer?.result !== 200) {
            return { status: "unreachable", reason: `result ${String(answer?.result)}` }
        }
        const theirs = peerScheduleView(answer.response)
        if (!theirs) return { status: "skipped" }
        return compareSchedules(ours, theirs)
    }
    return { status: "not-ready" }
}
