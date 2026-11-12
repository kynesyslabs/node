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
 *
 * A validator whose gasFeeSeparation treasury differs while both already
 * apply the fork is the exception: every fee-bearing block splits them and
 * there is no later height to wait for. A round where one answers so is handled as a
 * round inside the window, at any height, and logged as an error.
 *
 * The watch is driven by inserted blocks, so a node that restarts inside the
 * window would otherwise forge before its first comparison. The consensus
 * routine therefore awaits ensureWindowChecked() first: one conclusive round
 * per scheduled height before the node takes part, and one conclusive round
 * started after each requestScheduleCheck() (a peer seen with a different
 * treasury), at any height. A round that reached no validator stays
 * inconclusive and is retried on the next consensus round, so a node cut off
 * from every peer is not held back by it.
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
let currentRun: Promise<void> | null = null
// The scheduled height for which a round inside the window reached a validator.
let windowCheckedFor: number | null = null
// A round that was due while another was still running. Only the latest one is
// kept, so a slow round delays the next check but never drops it, and a backlog
// cannot build up.
let pendingTip: number | null = null
// requestScheduleCheck() calls so far, and how many of them a conclusive round
// started after the call has answered. A round already running when a call
// came may not have asked the peer that prompted it, so it does not count.
let requestedChecks = 0
let answeredChecks = 0

export interface RoundOutcome {
    /** Connection strings of the validators whose schedule differs. */
    mismatched: string[]
    /** Validators that answered and have the same schedule. */
    agreed: number
    /** Identities of the validators in `mismatched`. */
    mismatchedIdentities?: string[]
    /** Identities of the validators that answered with the same schedule. */
    agreedIdentities?: string[]
    /** Staked validators at this tip, lowercased; null when every peer counts. */
    validatorIdentities?: string[] | null
    /** Connection strings of the validators in `mismatched` whose gasFeeSeparation treasury differs. */
    treasuryMismatched?: string[]
    /**
     * Identities of the validators in `mismatched` whose own nearest scheduled
     * height is within WINDOW_BLOCKS of the tip: by their schedule they are in
     * the window, so they abstain even when ours schedules nothing near.
     */
    mismatchedInTheirWindow?: string[]
}

/** How often the comparison is repeated while the node abstains or leaves peers out. */
export const RECHECK_INTERVAL_MS = 30_000

let recheckTimer: ReturnType<typeof setInterval> | null = null

function stopRecheck(): void {
    if (recheckTimer === null) return
    clearInterval(recheckTimer)
    recheckTimer = null
}

/**
 * Re-runs the comparison on a timer while the abstain flag is up or differing
 * peers are left out of the shard, so either clears soon after an operator
 * fixes a schedule rather than at the next due block. A tick that
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
    if (!getSharedState.forkScheduleAbstain && getSharedState.forkScheduleDifferingPeers.size === 0) {
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
 *
 * A node in the majority leaves the differing validators out of its shard:
 * they abstain, so waiting for them would only stretch every round to its
 * timeouts. The set is started only inside the window, but kept past it while
 * peers still differ, because an abstaining node stays out until its schedule
 * agrees, after the fork height too. A validator leaves the set only by
 * answering with our schedule or by leaving the validator set: one that did not
 * answer (restarting, slow, not ready) may still abstain, and putting it back
 * in the shard could make it secretary of a round it never runs; so does a
 * round where the agreeing validators did not answer. Under `warn`, or while
 * this node abstains itself, nobody is left out.
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
    if (plan.inWindow) windowCheckedFor = plan.nearest
    setForkScheduleMismatch(differing > 0)

    const treasuryDiffers = (outcome.treasuryMismatched?.length ?? 0) > 0
    // A different treasury splits the chain already, so it is acted on as a
    // mismatch inside the window would be, wherever the tip is
    const urgent = plan.inWindow || treasuryDiffers
    const majorityDiffers = differing > outcome.agreed
    const abstaining =
        policy === "abstain" &&
        majorityDiffers &&
        (urgent || getSharedState.forkScheduleAbstain)
    const before = getSharedState.forkScheduleDifferingPeers
    const leaveOut = new Set<string>()
    if (policy === "abstain" && !abstaining) {
        const agreed = new Set((outcome.agreedIdentities ?? []).map(id => id.toLowerCase()))
        const staked = outcome.validatorIdentities ? new Set(outcome.validatorIdentities) : null
        for (const id of before) {
            if (!agreed.has(id) && (staked === null || staked.has(id))) leaveOut.add(id)
        }
        // A round where the differing side outnumbers the answers that agreed
        // is not grounds to add anyone: the agreeing validators may just have
        // timed out.
        // A node that abstained itself is past a mismatch too: the minority
        // still differing when it resumes may still abstain.
        const pastMismatch = before.size > 0 || getSharedState.forkScheduleAbstain
        if (!majorityDiffers && differing > 0 && (urgent || pastMismatch)) {
            for (const id of outcome.mismatchedIdentities ?? []) leaveOut.add(id.toLowerCase())
        }
        // A validator inside its own window abstains whatever our schedule
        // says. Left in the shard it is still drawn as secretary, and a round
        // whose secretary never starts stalls every validator.
        if (!majorityDiffers) {
            for (const id of outcome.mismatchedInTheirWindow ?? []) leaveOut.add(id.toLowerCase())
        }
    }
    if (leaveOut.size !== before.size || [...leaveOut].some(id => !before.has(id))) {
        getSharedState.forkScheduleDifferingPeers = leaveOut
        if (leaveOut.size > 0) {
            log.warn(
                `[FORK SCHEDULE] Leaving ${leaveOut.size} validator(s) out of the shard from block ${tip}` +
                    (differing > 0 ? ` (differing this round: ${outcome.mismatched.join(", ")})` : "") +
                    ": their schedule differs, so they abstain",
            )
        } else {
            log.info(`[FORK SCHEDULE] No validator left out of the shard from block ${tip}`)
        }
    }

    if (majorityDiffers) {
        if (!abstaining && leaveOut.size > 0) startRecheck()
        if (policy === "abstain" && urgent) {
            const reason =
                "fork schedule differs from " +
                outcome.mismatched.join(", ") +
                ` (${differing} of ${differing + outcome.agreed} validators)` +
                (treasuryDiffers
                    ? `, gasFeeSeparation treasury differs from ${outcome.treasuryMismatched!.join(", ")}`
                    : "") +
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

    if (leaveOut.size > 0) startRecheck()
    else stopRecheck()
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
    const answers = requestedChecks
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
    // the shard pool. If the set cannot be read the round is skipped: the
    // lenient read answers a failure with an empty set, which would let every
    // connected peer count.
    let validators: Set<string> | null
    try {
        const { readActiveValidatorAddresses } = await import(
            "@/libs/consensus/v2/routines/getShard"
        )
        const staked = await readActiveValidatorAddresses(tip, true)
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
    const outcome: RoundOutcome = {
        mismatched: [],
        agreed: 0,
        mismatchedIdentities: [],
        agreedIdentities: [],
        validatorIdentities: validators === null ? null : [...validators],
        treasuryMismatched: [],
        mismatchedInTheirWindow: [],
    }
    await mapWithLimit(peers, PEER_CONCURRENCY, async peer => {
        try {
            const result = await withTimeout<Awaited<ReturnType<typeof agreement.checkPeerSchedule>>>(
                agreement.checkPeerSchedule(peer, ours, { attempts: 1, tip }),
                PEER_TIMEOUT_MS,
                { status: "unreachable", reason: "timed out" },
            )
            if (result.status === "agree") {
                outcome.agreed++
                outcome.agreedIdentities!.push(String(peer.identity))
            }
            if (result.status !== "mismatch") return
            outcome.mismatched.push(peer.connection.string)
            outcome.mismatchedIdentities!.push(String(peer.identity))
            if (result.treasuryDiffers) outcome.treasuryMismatched!.push(peer.connection.string)
            const theirWindow =
                result.theirNearest !== undefined && result.theirNearest - tip <= WINDOW_BLOCKS
            if (theirWindow) outcome.mismatchedInTheirWindow!.push(String(peer.identity))
            const text =
                "[FORK SCHEDULE] MISMATCH with " +
                peer.connection.string +
                " at block " +
                tip +
                (plan.nearest !== null
                    ? " (nearest scheduled height " + plan.nearest + ")"
                    : "") +
                ": " +
                result.lines.join("; ") +
                (theirWindow ? ` (their nearest scheduled height ${result.theirNearest})` : "")
            if (plan.inWindow || result.treasuryDiffers || theirWindow) log.error(text)
            else log.warn(text)
        } catch {
            // One peer failing must not stop the others from being compared.
        }
    })
    await applyRoundOutcome(tip, plan, outcome)
    if (outcome.mismatched.length + outcome.agreed > 0) {
        answeredChecks = Math.max(answeredChecks, answers)
    }
}

function runRounds(first: number): Promise<void> {
    const run = drainRounds(first)
    currentRun = run
    return run
}

async function drainRounds(first: number): Promise<void> {
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

/** Forgets which scheduled height was checked. Exported for the test. */
export function resetWindowCheck(): void {
    windowCheckedFor = null
    lastStallCheckAt = null
    currentRun = null
    requestedChecks = 0
    answeredChecks = 0
}

/**
 * Makes sure the schedule was compared against the validators at least once
 * since the tip entered the window of the nearest scheduled fork, and once
 * since the last requestScheduleCheck(), waiting for a round that is already
 * running (with the one queued behind it) or starting one. Returns at once
 * under the warn policy, or when neither check is owed. Never throws: on
 * failure the node proceeds, as the periodic watch still runs.
 */
export async function ensureWindowChecked(tip: number): Promise<void> {
    try {
        const [{ getSharedState }, { Config }] = await Promise.all([
            import("@/utilities/sharedState"),
            import("@/config"),
        ])
        if (Config.getInstance().core.forkScheduleMismatchPolicy !== "abstain") {
            return
        }
        const plan = planScheduleCheck(
            tip,
            getSharedState.forkConfig as unknown as ForkConfigLike,
        )
        const owed = () =>
            answeredChecks < requestedChecks ||
            (plan.inWindow && windowCheckedFor !== plan.nearest)
        if (!owed()) return
        if (running && currentRun !== null) await currentRun.catch(() => undefined)
        if (!owed() || running) return
        await runRounds(tip)
    } catch {
        // A failed comparison must not stop consensus; the periodic watch retries.
    }
}

/**
 * Runs a comparison now rather than at the next due block, for a caller that
 * has just seen a peer whose treasury differs. Queued behind a running round
 * like a due block is. Until a conclusive round started after this call has
 * run, ensureWindowChecked() holds the consensus routine, so the caller need
 * not wait. Never throws.
 */
export async function requestScheduleCheck(): Promise<void> {
    // Counted before the first await, so it is owed as soon as the caller returns.
    requestedChecks++
    try {
        const { getSharedState } = await import("@/utilities/sharedState")
        const tip = getSharedState.lastBlockNumber
        if (running) {
            pendingTip = tip
            return
        }
        await runRounds(tip)
    } catch {
        // A failed comparison must not affect the caller; the periodic watch retries.
    }
}

let lastStallCheckAt: number | null = null

/**
 * For the consensus routine when a round stops because the secretary never
 * answered. The block-driven watch runs only on inserted blocks, so on a chain
 * stalled by an abstaining secretary it would never run again; this starts a
 * round instead, and ensureWindowChecked holds the next consensus round until
 * it has answered, so that round's shard already leaves the abstainer out.
 * At most once per RECHECK_INTERVAL_MS: secretary timeouts repeat every few
 * seconds, and each comparison asks every validator. Never throws.
 */
export async function onSecretaryUnresponsive(now: number = Date.now()): Promise<void> {
    try {
        const { Config } = await import("@/config")
        if (Config.getInstance().core.forkScheduleMismatchPolicy !== "abstain") return
        if (lastStallCheckAt !== null && now - lastStallCheckAt < RECHECK_INTERVAL_MS) return
        lastStallCheckAt = now
        await requestScheduleCheck()
    } catch {
        // A failed comparison must not affect the consensus routine.
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
