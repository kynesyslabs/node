/**
 * Scenario 11 — Quorum-loss halt and recovery drill (G3-6).
 *
 * Goal: with 2 of 4 validators stopped the chain must halt safely (no
 * block without quorum, survivors stay up and agree), and once the two
 * are started again the chain must resume and all 4 nodes converge.
 *
 * Setup:
 *  - 4 nodes on `genesis-fork-low.json` with `properties.shardSize`
 *    overridden to 4, so quorum is floor(2*4/3)+1 = 3 of 4.
 *
 * Action:
 *  1. Bring up. Wait until all 4 reach BASELINE_HEIGHT and agree on it.
 *  2. Record survivor restart counts. `docker compose stop node-3 node-4`.
 *  3. Settle for SETTLE_ROUNDS consensus rounds (a block already in
 *     flight may still land), then take the halt height.
 *  4. Sample survivor heads for HALT_ROUNDS rounds.
 *  5. `docker compose start node-3 node-4`. Wait for every node to
 *     reach haltHeight + RECOVERY_BLOCKS.
 *
 * Pass criteria (all must hold):
 *  P1 baseline: all 4 reach BASELINE_HEIGHT, same hash there.
 *  P2 halt: during step 4 every survivor answers RPC and no survivor's
 *     head exceeds the halt height.
 *  P3 halt agreement: survivors store the same hash at the halt height.
 *  P4 no crash: survivor restart counts unchanged from step 2 to the end.
 *  P5 recovery: within RECOVERY_TIMEOUT_MS all 4 heads reach
 *     haltHeight + RECOVERY_BLOCKS; every height from the halt height to
 *     that target has one hash on all 4 nodes, and every block above the
 *     halt height carries >= 3 signatures.
 *
 * Failure modes caught: a minority forging (safety), a survivor crashing
 * or the watchdog exiting it, restarted validators unable to sync back,
 * the chain staying halted after quorum returns (liveness).
 */

import { spawnSync } from "child_process"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs"
import {
    GENESIS_FORK_LOW,
    PROD_GENESIS_BACKUP_PATH,
    PROD_GENESIS_PATH,
    regenerateIdentities,
    sleep,
    startService,
    stopService,
    up,
    waitFor,
} from "../lib/devnetControl"
import { allReachedHeight, assertBlockHashConvergence } from "../lib/assertions"
import { getLastBlockNumber, query } from "../lib/nodeQueries"
import {
    type BlockRow,
    type HeightSample,
    drillPreconditionError,
    evaluateHalt,
    evaluateNoCrash,
    evaluateRecovery,
    signatureQuorum,
} from "../lib/haltDrill"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

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

function stageDrillGenesis(): void {
    if (!existsSync(PROD_GENESIS_BACKUP_PATH) && existsSync(PROD_GENESIS_PATH)) {
        copyFileSync(PROD_GENESIS_PATH, PROD_GENESIS_BACKUP_PATH)
    }
    const genesis = JSON.parse(readFileSync(GENESIS_FORK_LOW, "utf8"))
    genesis.properties.shardSize = DRILL_SHARD_SIZE
    writeFileSync(PROD_GENESIS_PATH, JSON.stringify(genesis, null, 4) + "\n")
}

function restartCount(id: number): number {
    const r = spawnSync(
        "docker",
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

async function blockRows(from: number, to: number): Promise<BlockRow[]> {
    const per = await Promise.all(
        NODE_IDS.map(async node =>
            (
                await query<{ number: number; hash: string; sigs: string }>(
                    node,
                    "SELECT number, hash, " +
                        "(SELECT count(*) FROM json_object_keys(validation_data->'signatures')) AS sigs " +
                        "FROM blocks WHERE number BETWEEN $1 AND $2",
                    [from, to],
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

async function scenario(ctx: ScenarioContext): Promise<void> {
    const pre = drillPreconditionError(DRILL_SHARD_SIZE, NODE_IDS.length, SURVIVORS.length)
    if (pre) fail("precondition", [pre])
    const quorum = signatureQuorum(DRILL_SHARD_SIZE, NODE_IDS.length)

    regenerateIdentities(4)
    stageDrillGenesis()
    up({ build: true })

    // P1 baseline
    await waitFor(async () => allReachedHeight(NODE_IDS, BASELINE_HEIGHT), {
        description: `all nodes reach height >= ${BASELINE_HEIGHT}`,
        timeoutMs: 240_000,
        intervalMs: 2_000,
    })
    await assertBlockHashConvergence(NODE_IDS, BASELINE_HEIGHT)
    ctx.notes.push(`P1 baseline: 4/4 at >= ${BASELINE_HEIGHT}, hashes agree`)

    const countsBefore = Object.fromEntries(SURVIVORS.map(id => [id, restartCount(id)]))
    for (const id of STOPPED) stopService(`node-${id}`)
    ctx.notes.push(`stopped ${STOPPED.map(id => `node-${id}`).join(", ")}`)

    await sleep(SETTLE_ROUNDS * ROUND_MS)
    const settled = await heads(SURVIVORS)
    if (Object.values(settled).some(h => h < 0)) {
        fail("P2 halt", [`a survivor did not answer after settle: ${JSON.stringify(settled)}`])
    }
    const haltHeight = Math.max(...Object.values(settled))

    // P2 halt
    const start = Date.now()
    const samples: HeightSample[] = []
    for (let i = 0; i < HALT_ROUNDS; i++) {
        await sleep(ROUND_MS)
        samples.push({ atMs: Date.now() - start, heights: await heads(SURVIVORS) })
    }
    const halt = evaluateHalt(SURVIVORS, haltHeight, samples, HALT_ROUNDS)
    if (!halt.pass) fail("P2 halt", halt.reasons)
    ctx.notes.push(`P2 halt: survivors held at ${haltHeight} for ${HALT_ROUNDS} rounds`)

    // P3 halt agreement
    await assertBlockHashConvergence(SURVIVORS, haltHeight)
    ctx.notes.push(`P3 survivors agree on block ${haltHeight}`)

    // P5 recovery
    for (const id of STOPPED) startService(`node-${id}`)
    const target = haltHeight + RECOVERY_BLOCKS
    await waitFor(async () => allReachedHeight(NODE_IDS, target), {
        description: `all nodes reach ${target} after restart`,
        timeoutMs: RECOVERY_TIMEOUT_MS,
        intervalMs: 2_000,
    })
    const recovery = evaluateRecovery(
        NODE_IDS,
        haltHeight,
        target,
        await heads(NODE_IDS),
        await blockRows(haltHeight, target),
        quorum,
    )
    if (!recovery.pass) fail("P5 recovery", recovery.reasons)
    ctx.notes.push(`P5 recovery: 4/4 at >= ${target}, hashes agree, >= ${quorum} signatures`)

    // P4 no crash
    const countsAfter = Object.fromEntries(SURVIVORS.map(id => [id, restartCount(id)]))
    const noCrash = evaluateNoCrash(countsBefore, countsAfter, SURVIVORS)
    if (!noCrash.pass) fail("P4 no crash", noCrash.reasons)
    ctx.notes.push("P4 survivors never exited")
}

await runScenarioCli("11-quorum-loss-halt-recovery", scenario)
