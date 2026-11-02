/**
 * Scenario 11 — SIGKILL replay (atomic block apply).
 *
 * Goal: a node killed with SIGKILL at any point while blocks with
 * transactions are being applied comes back with no partial state. Its
 * balances and nonces are never ahead of its chain, no assignment stamp
 * sits above its tip, and after catching up it holds the same blocks and
 * the same account state as the nodes that stayed up.
 *
 * Setup:
 *  - 4 nodes on `genesis-fork-low-gasFee.json` plus one funded harness
 *    wallet that streams transfers through the SDK for the whole run.
 *
 * Action, repeated for each round:
 *  1. Send a burst of transfers to node-1 and node-2.
 *  2. Wait for a new block, then `docker kill` one validator at a random
 *     offset inside the block interval. node-4 and node-2 alternate so
 *     both the consensus path (a signing member) and the sync path (the
 *     restarted node catching up) are exercised.
 *  3. `docker compose start` it and wait until it is back at the tip.
 *  4. Check its database: MAX(gcr_assigned_txs.block_number) <= MAX(blocks.number),
 *     and no drift or resync-from-scratch line in its logs.
 *
 * Asserts, at the end:
 *  - Every node holds the same block hash at a common height.
 *  - The harness wallet has the same balance and nonce on every node.
 *  - The sum of gcr_main balances is the same on every node.
 *  - Every transfer that was accepted is in a block on every node.
 *
 * Failure mode caught: state committed without its block (or a block
 * without its state) across an ungraceful restart; a re-synced block
 * applied twice.
 */

import { randomBytes } from "crypto"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import {
    DEVNET_DIR,
    GENESIS_FORK_LOW_GAS_FEE,
    PROD_GENESIS_PATH,
    REPO_ROOT,
    killService,
    logs,
    regenerateIdentities,
    sleep,
    stageGenesisWithFundedAccount,
    startService,
    waitFor,
} from "../lib/devnetControl"
import { allReachedHeight, assertBlockHashConvergence } from "../lib/assertions"
import { clearOverride, composeWithOverride, writeOverride } from "../lib/composeOverrides"
import {
    NODE_RPC_PORTS,
    getGcrAccount,
    getLastBlockNumber,
    query,
    sumGcrMain,
} from "../lib/nodeQueries"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const SCENARIO_ID = "11-sigkill-replay"
const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 5
const ROUNDS = Number(process.env.SIGKILL_ROUNDS ?? 4)
const BURST = Number(process.env.SIGKILL_BURST ?? 3)
const BLOCK_SECS = Number(process.env.CONSENSUS_TIME ?? 10)
/** Set when the `demos-devnet-node` image is built beforehand. */
const PREBUILT_IMAGE = process.env.DEVNET_PREBUILT_IMAGE === "1"
/** One OS unit per transfer; the wallet is funded far above the run's total. */
const AMOUNT = 1
const HARNESS_BALANCE = "1000000000000000000000"
const RECIPIENT = "0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c"

/** The validator killed in each round: the sync path and a signing member in turn. */
const victimOf = (round: number) => (round % 2 === 0 ? "node-4" : "node-2")

const VALIDATOR_STAKE = "1000000000000000000"

/**
 * The staged genesis names the four devnet identities as staked validators
 * and sizes the shard to them, so the committee floor can be met. The
 * fixture itself names no validators and a shard of 10.
 */
function stakeDevnetValidators(): void {
    const genesis = JSON.parse(readFileSync(PROD_GENESIS_PATH, "utf8"))
    const validators = NODE_IDS.map(id => ({
        address: readFileSync(resolve(DEVNET_DIR, "identities", `node${id}.pubkey`), "utf8").trim(),
        status: "2",
        connection_url: `http://node-${id}:${NODE_RPC_PORTS[id]}`,
        staked_amount: VALIDATOR_STAKE,
        first_seen: 0,
        valid_at: 0,
    }))
    const staked = new Set(validators.map(v => v.address))
    genesis.validators = validators
    genesis.balances = [
        ...validators.map(v => [v.address, VALIDATOR_STAKE]),
        ...(genesis.balances ?? []).filter((pair: [string, string]) => !staked.has(pair[0])),
    ]
    genesis.properties.shardSize = NODE_IDS.length
    writeFileSync(PROD_GENESIS_PATH, JSON.stringify(genesis, null, 4) + "\n")
}

/**
 * Gossip is off, as in the race and quorum harnesses: its sidecar needs
 * Node.js, which the devnet image does not ship. The staged genesis is
 * mounted because the image bakes in whatever the tree held when it was
 * built, and an empty directory hides the bundled testnet snapshot, whose
 * validator set would otherwise replace the genesis one.
 */
function overrideYaml(): string {
    const emptySnapshot = resolve(REPO_ROOT, "testing", "runs", SCENARIO_ID, "empty-snapshot")
    mkdirSync(emptySnapshot, { recursive: true })
    const lines = ["services:"]
    for (const id of NODE_IDS) {
        lines.push(
            `  node-${id}:`,
            "    environment:",
            '      GOSSIP_ENABLED: "false"',
            // Proposals travel as plain JSON over HTTP, as in the race harness.
            "      OMNI_MODE: HTTP_ONLY",
            "    volumes:",
            `      - ./identities/node${id}.identity:/app/.demos_identity:ro`,
            "      - ./demos_peerlist.json:/app/demos_peerlist.json:ro",
            "      - ./l2ps:/app/data/l2ps:ro",
            "      - ../../data/genesis.json:/app/data/genesis.json:ro",
            `      - ${emptySnapshot}:/app/data/snapshot:ro`,
        )
    }
    return lines.join("\n") + "\n"
}

async function client(nodeId: number, seed: Uint8Array): Promise<Demos> {
    const demos = new Demos()
    await demos.connect(`http://127.0.0.1:${NODE_RPC_PORTS[nodeId]}`)
    await demos.connectWallet(seed)
    return demos
}

/** confirm + broadcast; the hash when the node accepted it, else null. */
async function transfer(demos: Demos): Promise<string | null> {
    const tx = await demos.pay(RECIPIENT, AMOUNT)
    const confirmed = await DemosTransactions.confirm(tx, demos).catch(() => null)
    if (confirmed?.result !== 200 || confirmed?.response?.data?.valid === false) {
        return null
    }
    const sent = await DemosTransactions.broadcast(confirmed, demos).catch(() => null)
    return sent?.result === 200 ? (tx.hash as string) : null
}

/** The block a stored transaction landed in on one node, or null. */
async function landedOn(nodeId: number, hash: string): Promise<number | null> {
    const rows = await query<{ blockNumber: number | string | null }>(
        nodeId,
        'SELECT "blockNumber" FROM transactions WHERE hash = $1',
        [hash],
    )
    const value = rows[0]?.blockNumber
    return value === null || value === undefined ? null : Number(value)
}

/**
 * What the restarted node must never show: an assignment stamp above its
 * own tip (state committed without its block), or a drift line.
 */
async function assertNoPartialState(nodeId: number, label: string): Promise<void> {
    const [stamps, blocks] = await Promise.all([
        query<{ max: string | null }>(
            nodeId,
            "SELECT MAX(block_number)::text AS max FROM gcr_assigned_txs",
        ),
        query<{ max: string | null }>(nodeId, "SELECT MAX(number)::text AS max FROM blocks"),
    ])
    const highestStamp = Number(stamps[0]?.max ?? 0)
    const tip = Number(blocks[0]?.max ?? 0)
    if (highestStamp > tip) {
        throw new Error(
            `${label}: node-${nodeId} has GCR state stamped for block ${highestStamp} but its chain tip is ${tip}`,
        )
    }
    const tail = logs(`node-${nodeId}`, 400)
    for (const marker of [
        "exists but the block does not",
        "must be resynced from scratch",
        "local state has drifted",
        "already-confirmed tx",
    ]) {
        if (tail.includes(marker)) {
            throw new Error(`${label}: node-${nodeId} logged "${marker}" after its restart`)
        }
    }
}

async function waitAtTip(nodeId: number, description: string): Promise<void> {
    await waitFor(
        async () => {
            const tips = await Promise.all(
                NODE_IDS.map(id => getLastBlockNumber(id).catch(() => -1)),
            )
            if (tips.some(t => t < 0)) return false
            const others = NODE_IDS.filter(id => id !== nodeId).map(id => tips[id - 1])
            return tips[nodeId - 1] >= Math.min(...others) - 1
        },
        { description, timeoutMs: 240_000, intervalMs: 2_000 },
    )
}

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)

    const seed = new Uint8Array(randomBytes(32))
    const probe = new Demos()
    await probe.connectWallet(seed)
    const wallet = probe.getAddress()
    stageGenesisWithFundedAccount(GENESIS_FORK_LOW_GAS_FEE, wallet, HARNESS_BALANCE)
    stakeDevnetValidators()
    ctx.notes.push(`harness wallet ${wallet}`)

    writeOverride(SCENARIO_ID, overrideYaml())
    composeWithOverride(SCENARIO_ID, ["up", "-d", ...(PREBUILT_IMAGE ? [] : ["--build"])])
    await waitFor(async () => allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1), {
        description: `all nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
        timeoutMs: 600_000,
        intervalMs: 2_000,
    })
    ctx.notes.push("all nodes crossed the fork")

    const senders = [await client(1, seed), await client(2, seed)]
    const accepted: string[] = []

    for (let round = 0; round < ROUNDS; round++) {
        const victim = victimOf(round)
        const victimId = Number(victim.slice(-1))

        // A burst of transfers, alternating entry nodes.
        let sent = 0
        for (let i = 0; i < BURST; i++) {
            const hash = await transfer(senders[i % senders.length])
            if (hash) {
                accepted.push(hash)
                sent++
            }
            await sleep(500)
        }
        if (sent === 0) {
            throw new Error(`round ${round}: no transfer was accepted`)
        }

        // Kill inside the block interval, at a random offset after the next block.
        const before = await getLastBlockNumber(1)
        await waitFor(async () => (await getLastBlockNumber(1)) > before, {
            description: `round ${round}: a new block lands`,
            timeoutMs: 120_000,
            intervalMs: 500,
        })
        const offsetMs = Math.floor(Math.random() * BLOCK_SECS * 1000)
        await sleep(offsetMs)
        killService(victim)
        ctx.notes.push(
            `round ${round}: sent ${sent}, killed ${victim} ${offsetMs}ms into the block interval after block ${before + 1}`,
        )
        await sleep(3_000)
        startService(victim)

        await waitAtTip(victimId, `round ${round}: ${victim} back at the tip`)
        await assertNoPartialState(victimId, `round ${round}`)
        ctx.notes.push(`round ${round}: ${victim} restarted at tip ${await getLastBlockNumber(victimId)} with no partial state`)
    }

    // Let the last transfers land, then compare every node.
    await sleep(BLOCK_SECS * 2 * 1000)
    for (const id of NODE_IDS) await assertNoPartialState(id, "final")

    const tips = await Promise.all(NODE_IDS.map(id => getLastBlockNumber(id)))
    const common = Math.min(...tips)
    const hash = await assertBlockHashConvergence(NODE_IDS, common)
    ctx.notes.push(`block ${common} is ${hash.slice(0, 16)}… on every node`)

    const accounts = await Promise.all(NODE_IDS.map(id => getGcrAccount(id, wallet)))
    const nonces = await Promise.all(
        NODE_IDS.map(async id =>
            query<{ nonce: number }>(id, "SELECT nonce FROM gcr_main WHERE pubkey = $1", [wallet]),
        ),
    )
    const views = NODE_IDS.map(
        (id, i) => `node-${id}=${accounts[i]?.balance ?? "<none>"}/${nonces[i][0]?.nonce ?? "<none>"}`,
    )
    if (new Set(views.map(v => v.split("=")[1])).size !== 1) {
        throw new Error(`harness wallet differs across nodes: ${views.join(", ")}`)
    }
    ctx.notes.push(`harness wallet balance/nonce agrees: ${views[0].split("=")[1]}`)

    const sums = await Promise.all(NODE_IDS.map(id => sumGcrMain(id)))
    if (new Set(sums.map(String)).size !== 1) {
        throw new Error(
            `gcr_main sums differ: ${NODE_IDS.map((id, i) => `node-${id}=${sums[i]}`).join(", ")}`,
        )
    }
    ctx.notes.push(`gcr_main sum agrees on every node: ${sums[0]}`)

    for (const txHash of accepted) {
        const blocks = await Promise.all(NODE_IDS.map(id => landedOn(id, txHash)))
        if (blocks.some(b => b === null) || new Set(blocks).size !== 1) {
            throw new Error(
                `transfer ${txHash} landed in ${blocks.map((b, i) => `node-${NODE_IDS[i]}=${b}`).join(", ")}`,
            )
        }
    }
    ctx.notes.push(`${accepted.length} accepted transfers are in the same block on every node`)
    clearOverride(SCENARIO_ID)
}

await runScenarioCli("11-sigkill-replay", scenario)
