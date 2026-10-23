/**
 * Re-checks the fork schedule against the connected validators while the node runs.
 *
 * A comparison at bootstrap only covers what the peers had loaded at that
 * moment, and a genesis edit that rolls out over hours changes the answer
 * afterwards. So it is repeated every SLOW_EVERY blocks, and every WINDOW_EVERY
 * blocks once the tip is within WINDOW_BLOCKS of the nearest scheduled height,
 * where a mismatch is about to become a split and is logged as an error.
 *
 * Under FORK_SCHEDULE_MISMATCH_POLICY=abstain (the default) the node also skips
 * consensus rounds, but only when it is the odd one out: a strict majority of
 * the validators that answered must differ, inside the window. A minority of
 * differing peers is reported and left alone, because the node with the right
 * schedule is then this one, and a few bad peers (or non-validators) must not
 * be able to sideline it. While abstaining the node keeps syncing, and a timer
 * re-runs the comparison so the flag can clear without waiting for a block,
 * which a network of abstaining nodes would never produce. The flag clears once
 * no majority differs, inside the window or after it. Outside the window, or
 * under `warn`, a mismatch is only reported: stopping a node during a rolling
 * genesis edit far from any fork would cost liveness for no gain.
 */

import type { ForkConfigLike } from "./forkScheduleAgreement"
import {
    setConsensusAbstaining,
    setForkScheduleMismatch,
} from "@/features/metrics/consensusMetrics"

export const WINDOW_BLOCKS = 50
export const SLOW_EVERY = 100
export const WINDOW_EVERY = 10

export interface CheckPlan {
    due: boolean
    inWindow: boolean
    nearest: number | null
}

/** Whether to compare at this tip, and whether a mismatch is urgent. */
export function planScheduleCheck(
    tip: number,
    forkConfig: Record<string, { activationHeight: number | null } | undefined>,
): CheckPlan {
    let nearest: number | null = null
    for (const name of Object.keys(forkConfig)) {
        const h = forkConfig[name]?.activationHeight
        if (typeof h === "number" && h > tip && (nearest === null || h < nearest)) {
            nearest = h
        }
    }
    const inWindow = nearest !== null && nearest - tip <= WINDOW_BLOCKS
    const due = tip % SLOW_EVERY === 0 || (inWindow && tip % WINDOW_EVERY === 0)
    return { due, inWindow, nearest }
}

/** Peers asked at the same time, and how long one may take before it is given up on. */
export const PEER_CONCURRENCY = 4
export const PEER_TIMEOUT_MS = 3000

/**
 * Run `fn` over `items` with at most `limit` in flight. `fn` must not throw.
 * Exported for the test.
 */
export async function mapWithLimit<T>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++]
            await fn(item)
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, worker),
    )
}

/** Gives `promise` at most `ms`; the late answer is dropped, not awaited. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(onTimeout), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

let running = false
// A round that was due while another was still running. Only the latest one is
// kept, so a slow round delays the next check but never drops it, and a backlog
// cannot build up.
let pendingTip: number | null = null

export interface RoundOutcome {
    /** Connection strings of the validators whose schedule differs. */
    mismatched: string[]
    /** Validators that answered and have the same schedule. */
    agreed: number
}

/** How often the comparison is repeated while the node abstains. */
export const RECHECK_INTERVAL_MS = 30_000

let recheckTimer: ReturnType<typeof setInterval> | null = null

function stopRecheck(): void {
    if (recheckTimer === null) return
    clearInterval(recheckTimer)
    recheckTimer = null
}

/**
 * Re-runs the comparison on a timer while the abstain flag is up. A tick that
 * finds a round still running is skipped, so rounds never overlap and the timer
 * cannot build a backlog.
 */
function startRecheck(): void {
    if (recheckTimer !== null) return
    recheckTimer = setInterval(() => {
        void recheckOnce().catch(() => undefined)
    }, RECHECK_INTERVAL_MS)
    // The timer must not keep a shutting-down process alive.
    ;(recheckTimer as { unref?: () => void }).unref?.()
}

async function recheckOnce(): Promise<void> {
    const { getSharedState } = await import("@/utilities/sharedState")
    if (!getSharedState.forkScheduleAbstain) {
        stopRecheck()
        return
    }
    if (running) return
    await runRounds(getSharedState.lastBlockNumber)
}

/**
 * Turns one comparison round into the mismatch gauge and the abstain flag.
 *
 * Setting needs a strict majority of the validators that answered to differ,
 * inside the window, under the abstain policy. Clearing needs only that no
 * majority differs, wherever the tip is: once the nearest scheduled height is
 * behind the tip the window is over, and the node stays out only while most of
 * its peers still disagree with it. A round that reached no validator is
 * inconclusive and changes nothing: clearing on silence would let a node whose
 * peers are all unreachable resume consensus on a schedule it never confirmed.
 */
export async function applyRoundOutcome(
    tip: number,
    plan: CheckPlan,
    outcome: RoundOutcome,
): Promise<void> {
    const [{ getSharedState }, { Config }, { default: log }] = await Promise.all([
        import("@/utilities/sharedState"),
        import("@/config"),
        import("@/utilities/logger"),
    ])
    const policy = Config.getInstance().core.forkScheduleMismatchPolicy

    const differing = outcome.mismatched.length
    if (differing + outcome.agreed === 0) return
    setForkScheduleMismatch(differing > 0)

    if (differing > outcome.agreed) {
        if (policy === "abstain" && plan.inWindow) {
            const reason =
                "fork schedule differs from " +
                outcome.mismatched.join(", ") +
                ` (${differing} of ${differing + outcome.agreed} validators)` +
                (plan.nearest !== null
                    ? `, nearest scheduled height ${plan.nearest}`
                    : "") +
                "; the node keeps syncing and resumes once the schedules agree"
            const wasAbstaining = getSharedState.forkScheduleAbstain
            getSharedState.forkScheduleAbstainReason = reason
            getSharedState.forkScheduleAbstain = true
            setConsensusAbstaining(true)
            startRecheck()
            if (!wasAbstaining) {
                log.error(
                    `[FORK SCHEDULE] Abstaining from consensus from block ${tip}: ${reason}`,
                )
            }
        }
        return
    }

    stopRecheck()
    if (getSharedState.forkScheduleAbstain) {
        getSharedState.forkScheduleAbstain = false
        getSharedState.forkScheduleAbstainReason = ""
        setConsensusAbstaining(false)
        log.warn(
            `[FORK SCHEDULE] No majority of validators differs at block ${tip}: resuming consensus`,
        )
    }
}

async function compareWithPeers(tip: number, plan: CheckPlan): Promise<void> {
    const { getSharedState } = await import("@/utilities/sharedState")
    const forkConfig = getSharedState.forkConfig as unknown as ForkConfigLike
    const [{ default: PeerManager }, { default: log }, agreement] = await Promise.all([
        import("../PeerManager"),
        import("@/utilities/logger"),
        import("./forkScheduleAgreement"),
    ])
    const ours = agreement.localScheduleView(forkConfig, getSharedState.chainId)
    // Only staked validators count: a non-validator can open a connection and
    // answer getNetworkInfo with anything, and must not be able to sway the
    // majority. With no staked set (bare dev networks) every peer counts, as in
    // the shard pool. If the set cannot be read the round is skipped.
    let validators: Set<string> | null
    try {
        const { readActiveValidatorAddresses } = await import(
            "@/libs/consensus/v2/routines/getShard"
        )
        const staked = await readActiveValidatorAddresses(tip)
        validators = staked.size > 0 ? new Set([...staked].map(a => a.toLowerCase())) : null
    } catch (error) {
        log.warn(
            "[FORK SCHEDULE] Validator set unavailable, skipping the comparison: " +
                (error instanceof Error ? error.message : String(error)),
        )
        return
    }
    const peers = PeerManager.getInstance()
        .getPeers()
        .filter(peer => peer.identity !== getSharedState.publicKeyHex)
        .filter(
            peer =>
                validators === null ||
                validators.has(String(peer.identity).toLowerCase()),
        )
    const outcome: RoundOutcome = { mismatched: [], agreed: 0 }
    await mapWithLimit(peers, PEER_CONCURRENCY, async peer => {
        try {
            const result = await withTimeout<Awaited<ReturnType<typeof agreement.checkPeerSchedule>>>(
                agreement.checkPeerSchedule(peer, ours, { attempts: 1 }),
                PEER_TIMEOUT_MS,
                { status: "unreachable", reason: "timed out" },
            )
            if (result.status === "agree") outcome.agreed++
            if (result.status !== "mismatch") return
            outcome.mismatched.push(peer.connection.string)
            const text =
                "[FORK SCHEDULE] MISMATCH with " +
                peer.connection.string +
                " at block " +
                tip +
                (plan.nearest !== null
                    ? " (nearest scheduled height " + plan.nearest + ")"
                    : "") +
                ": " +
                result.lines.join("; ")
            if (plan.inWindow) log.error(text)
            else log.warn(text)
        } catch {
            // One peer failing must not stop the others from being compared.
        }
    })
    await applyRoundOutcome(tip, plan, outcome)
}

async function runRounds(first: number): Promise<void> {
    running = true
    try {
        const { getSharedState } = await import("@/utilities/sharedState")
        let current: number | null = first
        while (current !== null) {
            const forkConfig = getSharedState.forkConfig as unknown as ForkConfigLike
            await compareWithPeers(current, planScheduleCheck(current, forkConfig))
            current = pendingTip
            pendingTip = null
        }
    } finally {
        running = false
    }
}

/** Called after a block is inserted; never throws and never blocks the caller. */
export async function onBlockInserted(tip: number): Promise<void> {
    try {
        const { getSharedState } = await import("@/utilities/sharedState")
        const plan = planScheduleCheck(
            tip,
            getSharedState.forkConfig as unknown as ForkConfigLike,
        )
        if (!plan.due) return
        if (running) {
            pendingTip = tip
            return
        }
        await runRounds(tip)
    } catch {
        // A failed comparison must not affect block processing.
    }
}
