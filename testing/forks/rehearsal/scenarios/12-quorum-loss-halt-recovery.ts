/**
 * Scenario 12 — Quorum-loss halt and recovery drill (G3-6), at shardSize 4.
 *
 * Goal: with 2 of 4 validators stopped the chain must halt safely (no
 * block without quorum, survivors stay up and agree), and once the two
 * are started again the chain must resume and all 4 nodes converge.
 *
 * Setup:
 *  - 4 nodes on `genesis-fork-low.json` with `properties.shardSize`
 *    overridden to 4, so quorum is floor(2*4/3)+1 = 3 of 4. Mainnet runs
 *    shardSize 10; this drill does not exercise that committee size.
 *  - The fork set mainnet launches with: every fork that
 *    `docs/mainnet/genesis.template.json` sets to 0 is active from height 0,
 *    every null or "FILL: ..." one is off, and so is identityCarryover: it
 *    needs a genesis snapshot and this drill mounts an empty one (the legacy
 *    genesis path). Read from the template at run time (`withLaunchForks`),
 *    logged, and reported in `DRILL_TIMINGS` with the exclusions.
 *  - Inputs a 4-node devnet needs to forge, mounted through a compose
 *    override for this scenario only (lib/drillInputs.ts): genesis time 60 s
 *    ahead, a peerlist seeding node-1 only, an empty directory over
 *    /app/data/snapshot (else the image's 35 testnet validators replace the
 *    genesis ones). Once the containers are up, nodes 2-4 are restarted once.
 *
 * Action:
 *  1. Bring up. Wait until all 4 reach BASELINE_HEIGHT and agree on it.
 *  2. Wait until all 4 report the same head, record it as the pre-stop
 *     height, record survivor restart counts, then
 *     `docker compose stop node-3 node-4`.
 *  3. Settle for SETTLE_ROUNDS consensus rounds (a block already in
 *     flight may still land), then wait for the survivors to agree on a
 *     head and take that as the halt height.
 *  4. Sample survivor heads for HALT_ROUNDS rounds.
 *  5. `docker compose start node-3 node-4`. Wait for every node to
 *     reach haltHeight + RECOVERY_BLOCKS.
 *
 * Pass criteria (all must hold):
 *  P1 baseline: all 4 reach BASELINE_HEIGHT, same hash there.
 *  P2 settle: every block between the pre-stop height and the halt
 *     height is stored by both survivors with one hash and carries >= 3
 *     signatures (so a block the survivors committed alone fails).
 *  P3 halt: during step 4 every survivor answers RPC and every survivor
 *     head stays at the halt height.
 *  P4 halt agreement: survivors store the same hash at the halt height.
 *  P5 recovery: within RECOVERY_TIMEOUT_MS all 4 heads reach
 *     haltHeight + RECOVERY_BLOCKS; every height from the pre-stop height
 *     to that target has one hash on all 4 nodes, and every block above
 *     the pre-stop height carries >= 3 signatures.
 *  P6 no crash: survivor restart counts unchanged from step 2 to the end.
 *
 * Failure modes caught: a minority forging (safety), a survivor crashing
 * or the watchdog exiting it, restarted validators unable to sync back,
 * the chain staying halted after quorum returns (liveness).
 *
 * Not checked: that the restarted validators sign again. The chain
 * resumes with 3 signatures per block, which 2 survivors plus 1
 * restarted node already provide.
 */

import { spawnSync } from "child_process"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
    GENESIS_FORK_LOW,
    compose,
    isServiceRunning,
    logs,
    regenerateIdentities,
    restartService,
    sleep,
    startService,
    stopService,
    up,
    waitFor,
} from "../lib/devnetControl"
import { allReachedHeight, assertBlockHashConvergence } from "../lib/assertions"
import { clearOverride, overridePath, writeOverride } from "../lib/composeOverrides"
import { withCurrentDevnetValidators } from "../lib/drillGenesis"
import {
    LAUNCH_GENESIS_TEMPLATE,
    bootRefusalLine,
    drillOverrideYaml,
    genesisTimestamp,
    launchExcluded,
    stageDrillInputs,
    withLaunchForks,
} from "../lib/drillInputs"
import { getLastBlockNumber, query } from "../lib/nodeQueries"
import {
    type BlockRow,
    type DrillMarks,
    type HeightSample,
    agreedHeight,
    drillPreconditionError,
    emptyMarks,
    evaluateHalt,
    evaluateNoCrash,
    evaluateRecovery,
    evaluateSettle,
    formatSeconds,
    phaseDurations,
    signatureQuorum,
} from "../lib/haltDrill"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"
import { systemBinary } from "../lib/systemBinary"

const SCENARIO_ID = "12-quorum-loss"
const NODE_IDS = [1, 2, 3, 4]
const STOPPED = [3, 4]
const SURVIVORS = NODE_IDS.filter(id => !STOPPED.includes(id))
const DRILL_SHARD_SIZE = 4
const BASELINE_HEIGHT = 6
const CONSENSUS_TIME_S = Number(process.env.CONSENSUS_TIME ?? "10")
const ROUND_MS = CONSENSUS_TIME_S * 1_000
const SETTLE_ROUNDS = 2
const HALT_ROUNDS = 12
const RECOVERY_BLOCKS = 3
const RECOVERY_TIMEOUT_MS = 300_000
/** Upper bound on each database read, so a stalled Postgres fails the drill. */
const DB_READ_TIMEOUT_MS = 30_000
/** How long the survivors get to agree on a head after the settle period. */
const AGREE_TIMEOUT_MS = 3 * ROUND_MS
/**
 * Must run after `regenerateIdentities`: the genesis validators are the keys
 * that call just wrote. With any other set, the bound committee holds no
 * running node and the chain never leaves block 0.
 *
 * Not written to `data/genesis.json`: the genesis time has to be set once the
 * image is built, so the file is mounted into the nodes instead (see
 * `stageDrillInputs`).
 */
function buildDrillGenesis(): Record<string, any> {
    const genesis = withCurrentDevnetValidators(
        JSON.parse(readFileSync(GENESIS_FORK_LOW, "utf8")),
        NODE_IDS.length,
    )
    genesis.properties.shardSize = DRILL_SHARD_SIZE
    return withLaunchForks(genesis)
}

function restartCount(id: number): number {
    const r = spawnSync(
        systemBinary("docker"),
        ["inspect", "-f", "{{.RestartCount}}", `demos-devnet-node-${id}`],
        { encoding: "utf8" },
    )
    if (r.status !== 0) throw new Error(`docker inspect node-${id} failed: ${r.stderr}`)
    return Number(r.stdout.trim())
}

async function heads(ids: number[]): Promise<Record<number, number>> {
    const hs = await Promise.all(ids.map(id => getLastBlockNumber(id).catch(() => -1)))
    return Object.fromEntries(ids.map((id, i) => [id, hs[i]]))
}

async function agreedHead(ids: number[], description: string, timeoutMs: number) {
    return await waitFor(async () => agreedHeight(ids, await heads(ids)) ?? false, {
        description,
        timeoutMs,
        intervalMs: 1_000,
    })
}

async function blockRows(nodes: number[], from: number, to: number): Promise<BlockRow[]> {
    const per = await Promise.all(
        nodes.map(async node =>
            (
                await query<{ number: number; hash: string; sigs: string }>(
                    node,
                    "SELECT number, hash, " +
                        "(SELECT count(*) FROM json_object_keys(validation_data->'signatures')) AS sigs " +
                        "FROM blocks WHERE number BETWEEN $1 AND $2",
                    [from, to],
                    { timeoutMs: DB_READ_TIMEOUT_MS },
                )
            ).map(r => ({
                node,
                number: Number(r.number),
                hash: r.hash,
                signatures: Number(r.sigs),
            })),
        ),
    )
    return per.flat()
}

function fail(phase: string, reasons: string[]): never {
    throw new Error(`${phase} failed:\n  - ${reasons.join("\n  - ")}`)
}

/** Heights the drill observed, null until observed. Reported with the timings. */
interface DrillHeights {
    preStopHeight: number | null
    haltHeight: number | null
    targetHeight: number | null
    settleBlocks: number | null
}

function iso(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString()
}

/**
 * Pushes the per-phase timings to `ctx.notes` and prints one `DRILL_TIMINGS`
 * JSON line to stdout. Runs on failure too, with the marks not reached as
 * null. The scenario context has no run/log directory, so nothing is written
 * to a file.
 */
function reportTimings(
    ctx: ScenarioContext,
    marks: DrillMarks,
    observed: DrillHeights,
    forks: Record<string, number | null>,
    excludedForks: Record<string, string>,
): void {
    const d = phaseDurations(marks)
    const forkText = Object.entries(forks)
        .map(([name, height]) => `${name}@${height}`)
        .join(", ")
    ctx.notes.push(
        `timing: cold start to baseline ${formatSeconds(d.coldStartToBaselineMs)}`,
        `timing: stop to halt confirmed ${formatSeconds(d.stopToHaltConfirmedMs)}`,
        `timing: halt hold ${formatSeconds(d.haltHoldMs)}`,
        `timing: restart to first new block ${formatSeconds(d.restartToFirstNewBlockMs)}`,
        `timing: restart to all 4 converged ${formatSeconds(d.restartToConvergedMs)}`,
        `timing: total ${formatSeconds(d.totalMs)} (first up() return to convergence)`,
        `heights: pre-stop ${observed.preStopHeight ?? "n/a"}, halt ${observed.haltHeight ?? "n/a"}, ` +
            `target ${observed.targetHeight ?? "n/a"}, ${observed.settleBlocks ?? "n/a"} block(s) landed during settle`,
        `config: CONSENSUS_TIME ${CONSENSUS_TIME_S}s, shardSize ${DRILL_SHARD_SIZE}, forks ${forkText}`,
    )
    const line = {
        scenario: SCENARIO_ID,
        marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, iso(v)])),
        durationsMs: d,
        ...observed,
        consensusTimeS: CONSENSUS_TIME_S,
        shardSize: DRILL_SHARD_SIZE,
        excludedForks,
        forks,
    }
    process.stdout.write(`DRILL_TIMINGS ${JSON.stringify(line)}\n`)
}

async function scenario(ctx: ScenarioContext): Promise<void> {
    const pre = drillPreconditionError(DRILL_SHARD_SIZE, NODE_IDS.length, SURVIVORS.length)
    if (pre) fail("precondition", [pre])
    const quorum = signatureQuorum(DRILL_SHARD_SIZE, NODE_IDS.length)

    // Identities first: the genesis is built from the keys this writes.
    regenerateIdentities(NODE_IDS.length)
    const genesis = buildDrillGenesis()
    const forks: Record<string, number | null> = Object.fromEntries(
        Object.entries<any>(genesis.forks).map(([name, f]) => [name, f?.activationHeight ?? null]),
    )
    const excludedForks = launchExcluded()
    const excludedText =
        Object.entries(excludedForks)
            .map(([name, why]) => `${name} (${why})`)
            .join(", ") || "none"
    const active = Object.keys(forks).filter(name => forks[name] === 0)
    process.stdout.write(
        `[scenario 12] launch fork set from ${LAUNCH_GENESIS_TEMPLATE}: active at 0: ${active.join(", ")}; ` +
            `off: ${Object.keys(forks).filter(name => forks[name] !== 0).join(", ") || "none"}; ` +
            `excluded: ${excludedText}\n`,
    )
    const marks = emptyMarks()
    const observed: DrillHeights = {
        preStopHeight: null,
        haltHeight: null,
        targetHeight: null,
        settleBlocks: null,
    }
    // Build before the genesis time is set, so the build does not eat the delay.
    compose(["build"])

    const stagingDir = mkdtempSync(join(tmpdir(), "rehearsal-drill-"))
    try {
        const staged = stageDrillInputs({
            genesis,
            genesisTs: genesisTimestamp(Date.now()),
            dir: stagingDir,
        })
        writeOverride(
            SCENARIO_ID,
            drillOverrideYaml(staged, NODE_IDS, { consensusTimeS: CONSENSUS_TIME_S }),
        )
        up({ overrideFiles: [overridePath(SCENARIO_ID)] })
        marks.t_up = Date.now()
        await restartForColdStart()
        await drill(ctx, quorum, marks, observed)
    } catch (e) {
        throw withBootRefusals(e)
    } finally {
        // Also on failure: print what was collected before the error propagates.
        try {
            reportTimings(ctx, marks, observed, forks, excludedForks)
        } catch (e) {
            process.stderr.write(`[WARN] could not report drill timings: ${String(e)}\n`)
        }
        if (ctx.keepState) {
            ctx.notes.push(`--keep-state: left ${stagingDir} and ${overridePath(SCENARIO_ID)} in place`)
        } else {
            clearOverride(SCENARIO_ID)
            rmSync(stagingDir, { recursive: true, force: true })
        }
    }
}

/** The error with the "Refusing to boot" line of every node that logged one, so a refused genesis is not just a timeout. */
function withBootRefusals(e: unknown): unknown {
    if (!(e instanceof Error)) return e
    const refusals = NODE_IDS.flatMap(id => {
        try {
            const line = bootRefusalLine(logs(`node-${id}`, 400))
            return line === null ? [] : [`node-${id}: ${line}`]
        } catch {
            return []
        }
    })
    if (refusals.length > 0) e.message += `\nnode log:\n  ${refusals.join("\n  ")}`
    return e
}

/**
 * The peerlist seeds node-1 only, so at a cold start nodes 2-4 each see 2 of 4
 * live and refuse to forge. One restart of them, once all containers are up,
 * lets them find the whole set.
 */
async function restartForColdStart(): Promise<void> {
    await waitFor(async () => NODE_IDS.every(id => isServiceRunning(`node-${id}`)), {
        description: "all 4 node containers running",
        timeoutMs: 120_000,
        intervalMs: 2_000,
    })
    for (const id of NODE_IDS.slice(1)) restartService(`node-${id}`)
}

async function drill(
    ctx: ScenarioContext,
    quorum: number,
    marks: DrillMarks,
    observed: DrillHeights,
): Promise<void> {
    // P1 baseline
    await waitFor(async () => allReachedHeight(NODE_IDS, BASELINE_HEIGHT), {
        description: `all nodes reach height >= ${BASELINE_HEIGHT}`,
        timeoutMs: 240_000,
        intervalMs: 2_000,
    })
    await assertBlockHashConvergence(NODE_IDS, BASELINE_HEIGHT, { timeoutMs: DB_READ_TIMEOUT_MS })
    marks.t_baseline = Date.now()
    ctx.notes.push(`P1 baseline: 4/4 at >= ${BASELINE_HEIGHT}, hashes agree`)

    const countsBefore = Object.fromEntries(SURVIVORS.map(id => [id, restartCount(id)]))
    const preStopHeight = await agreedHead(
        NODE_IDS,
        "all 4 nodes report the same head before the stop",
        2 * ROUND_MS,
    )
    observed.preStopHeight = preStopHeight
    for (const id of STOPPED) stopService(`node-${id}`)
    marks.t_stop = Date.now()
    ctx.notes.push(
        `stopped ${STOPPED.map(id => `node-${id}`).join(", ")} at pre-stop height ${preStopHeight}`,
    )

    // P2 settle
    await sleep(SETTLE_ROUNDS * ROUND_MS)
    let haltHeight: number
    try {
        haltHeight = await agreedHead(SURVIVORS, "survivors agree on a head", AGREE_TIMEOUT_MS)
        observed.haltHeight = haltHeight
        observed.settleBlocks = haltHeight - preStopHeight
    } catch (e) {
        fail("P2 settle", [
            `survivors did not agree on a head after settle: ${JSON.stringify(await heads(SURVIVORS))}`,
            String(e),
        ])
    }
    const settle = evaluateSettle(
        SURVIVORS,
        preStopHeight,
        haltHeight,
        haltHeight > preStopHeight ? await blockRows(SURVIVORS, preStopHeight + 1, haltHeight) : [],
        quorum,
    )
    if (!settle.pass) fail("P2 settle", settle.reasons)
    marks.t_halt_confirmed = Date.now()
    ctx.notes.push(
        `P2 settle: ${haltHeight - preStopHeight} block(s) landed after the stop, all with >= ${quorum} signatures`,
    )

    // P3 halt
    const start = Date.now()
    const samples: HeightSample[] = []
    for (let i = 0; i < HALT_ROUNDS; i++) {
        await sleep(ROUND_MS)
        samples.push({ atMs: Date.now() - start, heights: await heads(SURVIVORS) })
    }
    const halt = evaluateHalt(SURVIVORS, haltHeight, samples, HALT_ROUNDS)
    if (!halt.pass) fail("P3 halt", halt.reasons)
    marks.t_hold_end = Date.now()
    ctx.notes.push(`P3 halt: survivors held at ${haltHeight} for ${HALT_ROUNDS} rounds`)

    // P4 halt agreement
    await assertBlockHashConvergence(SURVIVORS, haltHeight, { timeoutMs: DB_READ_TIMEOUT_MS })
    ctx.notes.push(`P4 survivors agree on block ${haltHeight}`)

    // P5 recovery
    for (const id of STOPPED) startService(`node-${id}`)
    marks.t_restart = Date.now()
    const target = haltHeight + RECOVERY_BLOCKS
    observed.targetHeight = target
    await waitFor(
        async () => {
            // Extra read only to time the first block above the halt height; the
            // pass criterion is still allReachedHeight, with the same timeout.
            if (marks.t_first_new_block === null) {
                const hs = await heads(NODE_IDS)
                if (Math.max(...Object.values(hs)) > haltHeight) marks.t_first_new_block = Date.now()
            }
            return allReachedHeight(NODE_IDS, target)
        },
        {
            description: `all nodes reach ${target} after restart`,
            timeoutMs: RECOVERY_TIMEOUT_MS,
            intervalMs: 2_000,
        },
    )
    const recovery = evaluateRecovery(
        NODE_IDS,
        preStopHeight,
        target,
        await heads(NODE_IDS),
        await blockRows(NODE_IDS, preStopHeight, target),
        quorum,
    )
    if (!recovery.pass) fail("P5 recovery", recovery.reasons)
    marks.t_converged = Date.now()
    ctx.notes.push(
        `P5 recovery: chain resumed; 4/4 at >= ${target}, hashes agree from ${preStopHeight}, ` +
            `>= ${quorum} signatures per block`,
    )

    // P6 no crash
    const countsAfter = Object.fromEntries(SURVIVORS.map(id => [id, restartCount(id)]))
    const noCrash = evaluateNoCrash(countsBefore, countsAfter, SURVIVORS)
    if (!noCrash.pass) fail("P6 no crash", noCrash.reasons)
    ctx.notes.push("P6 survivors never exited")
}

await runScenarioCli("12-quorum-loss-halt-recovery", scenario)
