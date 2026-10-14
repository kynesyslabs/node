/**
 * Scenario for the signatureDomain / web2ProofBinding activation rehearsal.
 * Start it with ./rehearsal.sh, which brings up the 4-validator devnet and
 * sets the environment this reads.
 *
 * Steps (each writes its own log and raw responses under $RUN_DIR/steps).
 * With UPGRADE_PATH=1 the chain starts with no schedule and steps U1 and U2 come first:
 *   U1  the chain runs without any fork schedule or chain id
 *   U2  the schedule is added to the genesis file of every node, which are restarted
 *       twice; the file must keep the schedule and the nodes must keep loading it
 * Then, in both modes:
 *   1  fork configuration as the nodes and the loader see it
 *   2  before the activation height: legacy-signed accepted, domain-signed refused
 *   3  the activation block itself: judged at tip H-1, the rule of block H
 *   4  after the activation height: legacy refused, domain accepted
 *   5  every validator agrees on block hashes across the activation height
 * and only without UPGRADE_PATH:
 *   6  one validator that boots without the fork schedule cannot vote with the rest
 *   7  its stall watchdog ends it, and it rejoins once its genesis is corrected
 *   8  nothing else restarted or ran out of memory
 */
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { txSignaturePreimage } from "../../src/libs/crypto/txSignaturePreimage"

const env = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`${k} must be set; run this through rehearsal.sh`)
    return v
}
const ROOT = env("ROOT")
const RUN_DIR = env("RUN_DIR")
const PROJECT = env("PROJECT")
const UPGRADE = process.env.UPGRADE_PATH === "1"
const UPGRADE_LEAD = Number(process.env.UPGRADE_LEAD ?? 30)
// In the upgrade path the height is only known once the schedule is added to the running chain.
let H = Number(env("ACTIVATION_HEIGHT"))
const CHAIN_ID = Number(env("CHAIN_ID"))
const BLOCK_SECS = Number(env("CONSENSUS_TIME"))
const PORTS = [53551, 53553, 53555, 53557]
const DBS = ["node1_db", "node2_db", "node3_db", "node4_db"]
const identity = (name: string, ext: string) => readFileSync(`${RUN_DIR}/data/identities/${name}.${ext}`, "utf8").trim()
const ALICE = identity("alice", "pubkey")
const BOB = identity("bob", "pubkey")
const AMOUNT = 1_000_000_000n

// An absolute path, not a name looked up in PATH.
const DOCKER = ["/usr/bin/docker", "/usr/local/bin/docker"].find(existsSync)
if (!DOCKER) throw new Error("docker not found at /usr/bin or /usr/local/bin")

// ---- reporting -------------------------------------------------------------

let stepNo = 0
let stepFile = `${RUN_DIR}/steps/00-setup.log`
mkdirSync(`${RUN_DIR}/steps`, { recursive: true })
// The SDK prints debug output while it builds transactions; the report goes through say().
console.log = () => {}
function say(line: string) {
    process.stdout.write(line + "\n")
    appendFileSync(stepFile, line + "\n")
}
function step(name: string) {
    stepNo++
    stepFile = `${RUN_DIR}/steps/${String(stepNo).padStart(2, "0")}-${name.replace(/\W+/g, "-").toLowerCase()}.log`
    say(`\n== ${stepNo}. ${name}`)
}
function check(ok: boolean, what: string) {
    say(`${ok ? "PASS" : "FAIL"}  ${what}`)
    if (!ok) process.exitCode = 1
}
/** Keep the exact response on disk; echo a bounded copy. */
function record(label: string, value: unknown) {
    const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    writeFileSync(`${stepFile.replace(/\.log$/, "")}.${label.replace(/\W+/g, "-")}.json`, text + "\n")
    say(`   ${label}: ${text.replace(/\s+/g, " ").slice(0, 600)}`)
}
const execFileAsync = promisify(execFile)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, secs: number, everyMs = 2000) {
    const deadline = Date.now() + secs * 1000
    while (Date.now() < deadline) {
        if (await fn()) return true
        await sleep(everyMs)
    }
    return false
}

// ---- node access -----------------------------------------------------------

async function nodeCall(port: number, message: string, data: unknown = {}) {
    const res = await fetch(`http://localhost:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data, muid: "rehearsal" }] }),
        signal: AbortSignal.timeout(8000),
    })
    return (await res.json()) as { result: number; response: any; extra?: any }
}
const tipOf = async (port: number) => {
    try {
        const r = await nodeCall(port, "getLastBlockNumber")
        return typeof r.response === "number" ? r.response : -1
    } catch {
        return -1
    }
}
const hashAt = async (port: number, n: number) => {
    try {
        const r = await nodeCall(port, "getBlockByNumber", { blockNumber: n })
        return r.result === 200 ? (r.response.hash as string) : null
    } catch {
        return null
    }
}
const sql = (db: string, q: string) =>
    execFileSync(DOCKER, ["exec", `${PROJECT}-postgres`, "psql", "-U", "demosuser", "-d", db, "-Atc", q]).toString().trim()
const everyDb = (q: string) => DBS.map(db => sql(db, q))

/** Every node's account state at one moment when all four tips agree and hold still. */
async function settledStates(secs = 90) {
    const stateSql = `select md5(coalesce(string_agg(pubkey||balance||nonce, ',' order by pubkey),'')) from gcr_main`
    let states: string[] = []
    const ok = await until(async () => {
        const before = await Promise.all(PORTS.map(tipOf))
        if (before.some(t => t < 0) || new Set(before).size !== 1) return false
        states = everyDb(stateSql)
        const after = await Promise.all(PORTS.map(tipOf))
        return after.every((t, i) => t === before[i])
    }, secs, 700)
    return ok ? states : null
}
/** Validators whose signatures sit in the stored block, from node 1's database. */
const signersOf = (n: number): string[] => {
    const raw = sql("node1_db", `select validation_data::text from blocks where number=${n}`)
    return raw ? Object.keys(JSON.parse(raw).signatures ?? {}) : []
}
const restartCounts = () =>
    [1, 2, 3, 4].map(n =>
        execFileSync(DOCKER, ["inspect", "-f", "{{.RestartCount}} {{.State.OOMKilled}}", `${PROJECT}-node-${n}`]).toString().trim(),
    )
const nodeLog = (n: number, since?: string) =>
    execFileSync(DOCKER, ["logs", ...(since ? ["--since", since] : []), `${PROJECT}-node-${n}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
    }).replace(/\u001b\[[0-9;]*m/g, "")

// ---- transactions ----------------------------------------------------------

async function client(port: number, who: string) {
    const demos = new Demos()
    await demos.connect(`http://localhost:${port}`)
    await demos.connectWallet(identity(who, "identity"))
    return demos
}

type Flavour = "legacy" | { chainId: number }
/**
 * Re-sign an already built transaction over a chosen preimage. Content and hash
 * are untouched, so the same transaction can be offered with either signature.
 */
async function signAs(demos: Demos, tx: any, flavour: Flavour) {
    const bytes =
        flavour === "legacy"
            ? txSignaturePreimage(tx.hash, 0, false)
            : txSignaturePreimage(tx.hash, flavour.chainId, true)
    const signed = await demos.crypto.sign(demos.algorithm, bytes)
    return { ...tx, signature: { type: demos.algorithm, data: uint8ArrayToHex(signed.signature) } }
}

interface Outcome {
    accepted: boolean
    stage: string
    detail: unknown
}
/** confirm + broadcast, keeping whatever the node answered at each stage. */
async function submit(demos: Demos, tx: any): Promise<Outcome> {
    let confirmed: any
    try {
        confirmed = await DemosTransactions.confirm(tx, demos)
    } catch (e) {
        return { accepted: false, stage: "confirm", detail: { thrown: String(e) } }
    }
    const validity = confirmed?.response?.data?.valid
    if (confirmed?.result !== 200 || validity === false) {
        return { accepted: false, stage: "confirm", detail: stripValidity(confirmed) }
    }
    try {
        const sent = await DemosTransactions.broadcast(confirmed, demos)
        const ok = sent?.result === 200
        return { accepted: ok, stage: "broadcast", detail: sent }
    } catch (e) {
        return { accepted: false, stage: "broadcast", detail: { thrown: String(e) } }
    }
}
/** The node's signed validity envelope is long; keep the part that says why. */
function stripValidity(r: any) {
    if (!r || typeof r !== "object") return r
    const { response, ...rest } = r
    return { ...rest, response: response?.data ? { valid: response.data.valid, message: response.data.message } : response }
}

/** Block a stored transaction landed in, read from every node's own database. */
const landed = (hash: string) => everyDb(`select "blockNumber" from transactions where hash='${hash}'`).map(v => (v === "" ? null : Number(v)))
async function waitIncluded(hash: string, secs = 90) {
    const ok = await until(() => landed(hash).every(b => b !== null), secs)
    return ok ? landed(hash) : null
}
async function nextNonceReady(demos: Demos, previous: number) {
    return until(async () => Number((await demos.getAddressInfo(ALICE))?.nonce ?? 0) > previous, 60, 1000)
}

// ============================================================================

// Peer pairing at start-up can make a node exit and be restarted by the engine; what
// matters is that nothing restarts or runs out of memory once the scenario is running.
const startupRestarts = restartCounts()
const NODE4_KEY = identity("node4", "pubkey")
const alice = await client(PORTS[0], "alice")
let aliceNonce = Number((await alice.getAddressInfo(ALICE))?.nonce ?? 0)
say(`rehearsal: forks at ${H}, chain id ${CHAIN_ID}, ~${BLOCK_SECS}s per block, alice nonce ${aliceNonce}`)

// ---- U ---------------------------------------------------------------------
let restartsBaseline = startupRestarts
if (UPGRADE) {
    step("U1 a chain that starts without a fork schedule")
    const info0 = await Promise.all(PORTS.map(p => nodeCall(p, "getNetworkInfo")))
    record("getNetworkInfo-node1-before-upgrade", info0[0].response)
    check(
        info0.every(i => i.response.forks.signatureDomain.activationHeight === null && i.response.chainId === null),
        "every node reports signatureDomain unscheduled and no chain id: the chain started without either",
    )
    check(await until(async () => (await tipOf(PORTS[0])) >= 10, 240, 3000), "the chain produced 10 blocks")
    check(
        [8, 9, 10].every(n => signersOf(n).length === 4),
        "blocks 8 to 10 carry all four validator signatures",
    )

    step("U2 the schedule is added to the running chain")
    const tipAtEdit = await tipOf(PORTS[0])
    H = tipAtEdit + UPGRADE_LEAD
    const base = JSON.parse(readFileSync(`${RUN_DIR}/data/genesis.json`, "utf8"))
    base.properties.id = CHAIN_ID
    base.forks.signatureDomain = { activationHeight: H }
    base.forks.web2ProofBinding = { activationHeight: H }
    const upgraded = JSON.stringify(base, null, 2) + "\n"
    writeFileSync(`${RUN_DIR}/data/genesis.json`, upgraded)
    // In place, so the containers' bind mounts see the new content.
    for (let n = 1; n <= 4; n++) writeFileSync(`${RUN_DIR}/data/genesis.node${n}.json`, upgraded)
    say(`   tip ${tipAtEdit}: properties.id=${CHAIN_ID} and both activation heights ${H} written to all four genesis files`)

    const fileCarries = (n: number) => {
        const g = JSON.parse(readFileSync(`${RUN_DIR}/data/genesis.node${n}.json`, "utf8"))
        return g.properties?.id === CHAIN_ID && g.forks?.signatureDomain?.activationHeight === H && g.forks?.web2ProofBinding?.activationHeight === H
    }
    const restartAll = async () => {
        const at = new Date().toISOString()
        await Promise.all([1, 2, 3, 4].map(n => execFileAsync(DOCKER, ["restart", "-t", "2", `${PROJECT}-node-${n}`])))
        return at
    }
    for (const round of ["first", "second"]) {
        const at = await restartAll()
        const booted = await until(
            () => [1, 2, 3, 4].every(n => /Valid peers found/.test(nodeLog(n, at))),
            240,
            4000,
        )
        check(booted, `${round} restart: all four nodes finished peer bootstrap`)
        const logged = [1, 2, 3, 4].map(n => ({
            n,
            sig: new RegExp(`Loaded fork "signatureDomain" with activationHeight=${H}`).test(nodeLog(n, at)),
            web2: new RegExp(`Loaded fork "web2ProofBinding" with activationHeight=${H}`).test(nodeLog(n, at)),
            mismatch: /Genesis data hash does not match/.test(nodeLog(n, at)),
        }))
        record(`boot-log-${round}-restart`, logged)
        check(logged.every(l => l.sig && l.web2), `${round} restart: every node loaded both forks at ${H} from its genesis file`)
        const files = [1, 2, 3, 4].map(fileCarries)
        record(`genesis-files-after-${round}-restart`, files)
        check(files.every(Boolean), `${round} restart: after bootstrap every node's genesis file still carries properties.id and both activation heights`)
        check(!logged.some(l => l.mismatch), `${round} restart: no node reported a genesis data hash mismatch`)
        const infos2 = await Promise.all(PORTS.map(p => nodeCall(p, "getNetworkInfo")))
        check(
            infos2.every(i => i.response.forks.signatureDomain.activationHeight === H && i.response.chainId === CHAIN_ID),
            `${round} restart: getNetworkInfo reports signatureDomain at ${H} and chain id ${CHAIN_ID} on every node`,
        )
    }
    const tipAfterRestarts = await tipOf(PORTS[0])
    check(tipAfterRestarts < H - 8, `both restarts finished before the height (tip ${tipAfterRestarts}, height ${H})`)
    check(await until(async () => (await Promise.all(PORTS.map(tipOf))).every(t => t >= tipAfterRestarts + 3), 120, 3000), "the chain keeps producing blocks after the restarts")
    const tipNow = Math.min(...(await Promise.all(PORTS.map(tipOf))))
    const recent = [tipNow - 1, tipNow].map(n => ({ n, signers: signersOf(n).length }))
    record("signers-after-restarts", recent)
    check(recent.every(b => b.signers === 4), `blocks ${tipNow - 1} and ${tipNow} carry all four signatures`)
    restartsBaseline = restartCounts()
}

// ---- 1 ---------------------------------------------------------------------
step("fork configuration")
const infos = await Promise.all(PORTS.map(p => nodeCall(p, "getNetworkInfo")))
record("getNetworkInfo-node1", infos[0].response)
check(
    infos.every(i => i.response.forks.signatureDomain.activationHeight === H && i.response.chainId === CHAIN_ID),
    `all 4 nodes report signatureDomain at ${H} and chain id ${CHAIN_ID}`,
)
check(
    infos.every(i => i.response.forks.osDenomination.activated === true),
    "osDenomination is active from genesis (the fork this one is layered on)",
)
check(
    infos.every(i => !("web2ProofBinding" in i.response.forks)),
    "getNetworkInfo does not report web2ProofBinding (operators must read it from the node log)",
)
const loaded = (n: number) =>
    execFileSync(DOCKER, ["logs", `${PROJECT}-node-${n}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const logHas = (n: number, fork: string) =>
    new RegExp(`Loaded fork "${fork}" with activationHeight=${H}`).test(loaded(n))
check(
    [1, 2, 3, 4].every(n => logHas(n, "signatureDomain") && logHas(n, "web2ProofBinding")),
    `every node logged both forks loaded at activationHeight=${H}`,
)
// A node's own view of the other forks, from the same loader the nodes run.
{
    const { loadForkConfigFromGenesis } = await import("../../src/forks/loadForkConfig")
    const { isForkActive } = await import("../../src/forks/forkGates")
    const { DEFAULT_FORK_CONFIG } = await import("../../src/forks/forkConfig")
    const genesis = JSON.parse(readFileSync(`${RUN_DIR}/data/genesis.json`, "utf8"))
    loadForkConfigFromGenesis(genesis)
    const edge = (f: "signatureDomain" | "web2ProofBinding") => [isForkActive(f, H - 1), isForkActive(f, H)]
    record("loader-edges", { signatureDomain: edge("signatureDomain"), web2ProofBinding: edge("web2ProofBinding") })
    check(
        [edge("signatureDomain"), edge("web2ProofBinding")].every(([before, at]) => before === false && at === true),
        `loader: both forks inactive at ${H - 1}, active at ${H}`,
    )
    check(
        DEFAULT_FORK_CONFIG.tlsnProofEnforcement.activationHeight === null &&
            isForkActive("tlsnProofEnforcement", 1_000_000_000) === false,
        "tlsnProofEnforcement defaults to unscheduled (inactive at every height) when genesis does not name it",
    )
}

// ---- 2 ---------------------------------------------------------------------
step("before the activation height")
const tipBefore = await tipOf(PORTS[0])
say(`   tip is ${tipBefore}; activation at ${H}`)
check(tipBefore >= 0 && tipBefore <= H - 6, "enough blocks left before the activation height to run this step")
check(
    (await nodeCall(PORTS[0], "getNetworkInfo")).response.forks.signatureDomain.activated === false,
    "getNetworkInfo reports signatureDomain not yet activated",
)

const preBase = await alice.pay(BOB, AMOUNT)
const preLegacy = await signAs(alice, preBase, "legacy")
const preDomain = await signAs(alice, preBase, { chainId: CHAIN_ID })
const rPreDomain = await submit(alice, preDomain)
record("domain-signed-before", rPreDomain)
check(!rPreDomain.accepted, `domain-signed transfer refused before the height (at ${rPreDomain.stage})`)
const rPreLegacy = await submit(alice, preLegacy)
record("legacy-signed-before", rPreLegacy)
check(rPreLegacy.accepted, "legacy-signed transfer accepted before the height")
const preBlocks = await waitIncluded(preBase.hash)
record("legacy-signed-before-block", { hash: preBase.hash, blockPerNode: preBlocks })
check(
    preBlocks !== null && preBlocks.every(b => b === preBlocks[0]) && preBlocks[0]! < H,
    `legacy-signed transfer included in the same block on all 4 nodes, below the height (block ${preBlocks?.[0]})`,
)
await nextNonceReady(alice, aliceNonce)
aliceNonce++

// ---- 3 ---------------------------------------------------------------------
step("the activation block")
// Built ahead of time so the window at tip H-1 is spent submitting, not signing.
const edgeBase = await alice.pay(BOB, AMOUNT)
const edgeLegacy = await signAs(alice, edgeBase, "legacy")
const edgeDomain = await signAs(alice, edgeBase, { chainId: CHAIN_ID })
const caught = await until(async () => (await tipOf(PORTS[0])) === H - 1, (H + 2) * BLOCK_SECS, 250)
const tipAtEdge = await tipOf(PORTS[0])
check(caught, `caught the chain at tip ${H - 1}, the last block before the activation block (tip ${tipAtEdge})`)
const infoAtEdge = (await nodeCall(PORTS[0], "getNetworkInfo")).response.forks.signatureDomain
record("getNetworkInfo-at-edge", infoAtEdge)
check(
    infoAtEdge.activated === true,
    "at tip H-1 getNetworkInfo already reports the fork active: it answers for the block a new transaction would land in",
)
const rEdgeLegacy = await submit(alice, edgeLegacy)
record("legacy-signed-at-edge", rEdgeLegacy)
check(!rEdgeLegacy.accepted, `legacy-signed transfer refused at tip ${H - 1} (it would land in block ${H}), at ${rEdgeLegacy.stage}`)
const rEdgeDomain = await submit(alice, edgeDomain)
record("domain-signed-at-edge", rEdgeDomain)
check(rEdgeDomain.accepted, `domain-signed transfer accepted at tip ${H - 1}`)
const edgeBlocks = await waitIncluded(edgeBase.hash)
record("domain-signed-at-edge-block", { hash: edgeBase.hash, blockPerNode: edgeBlocks })
check(
    edgeBlocks !== null && edgeBlocks.every(b => b === edgeBlocks[0]) && edgeBlocks[0]! >= H,
    `domain-signed transfer included in the same block on all 4 nodes, at or after the height (block ${edgeBlocks?.[0]})`,
)
await nextNonceReady(alice, aliceNonce)
aliceNonce++

step("after the activation height")
check(await until(async () => (await tipOf(PORTS[0])) >= H + 1, 120), `chain passed height ${H}`)
// A client that connects now learns the activation from getNetworkInfo, which is
// what a deployed SDK does; the explicit signatures above and below are for the
// two preimages a client could still be producing.
const fresh = await client(PORTS[0], "alice")
const postBase = await fresh.pay(BOB, AMOUNT)
const postSdk = postBase // signed by the SDK itself from the node's getNetworkInfo
const expectDomain = await signAs(fresh, postBase, { chainId: CHAIN_ID })
check(
    postSdk.signature.data === expectDomain.signature.data,
    "a client that follows getNetworkInfo signs the domain preimage on its own (SDK output equals the node-helper preimage)",
)
const postLegacy = await signAs(fresh, postBase, "legacy")
const wrongChain = await signAs(fresh, postBase, { chainId: CHAIN_ID + 1 })
const rPostLegacy = await submit(fresh, postLegacy)
record("legacy-signed-after", rPostLegacy)
check(!rPostLegacy.accepted, `legacy-signed transfer refused after the height (at ${rPostLegacy.stage})`)
const rWrong = await submit(fresh, wrongChain)
record("wrong-chain-id-after", rWrong)
check(!rWrong.accepted, `domain-signed transfer bound to chain id ${CHAIN_ID + 1} refused (at ${rWrong.stage})`)
const rPostDomain = await submit(fresh, postSdk)
record("domain-signed-after", rPostDomain)
check(rPostDomain.accepted, "domain-signed transfer accepted after the height")
const postBlocks = await waitIncluded(postBase.hash)
record("domain-signed-after-block", { hash: postBase.hash, blockPerNode: postBlocks })
check(
    postBlocks !== null && postBlocks.every(b => b === postBlocks[0]) && postBlocks[0]! > H,
    `domain-signed transfer included in the same block on all 4 nodes (block ${postBlocks?.[0]})`,
)
await nextNonceReady(fresh, aliceNonce)
aliceNonce++

// ---- 4 ---------------------------------------------------------------------
step("agreement across the activation height")
const common = await (async () => {
    await until(async () => (await Promise.all(PORTS.map(tipOf))).every(t => t >= H + 3), 120)
    return Math.min(...(await Promise.all(PORTS.map(tipOf))))
})()
const heights = Array.from({ length: common - (H - 3) + 1 }, (_, i) => H - 3 + i)
const grid = await Promise.all(heights.map(async n => ({ n, hashes: await Promise.all(PORTS.map(p => hashAt(p, n))) })))
record("block-hashes", grid)
const split = grid.filter(g => g.hashes.some(h => h === null || h !== g.hashes[0]))
check(split.length === 0, `block hashes identical on all 4 nodes for blocks ${heights[0]}..${common}, across the height ${H}`)
const signerGrid = heights.map(n => ({ n, signers: signersOf(n).length, node4: signersOf(n).includes(NODE4_KEY) }))
record("signers-per-block-healthy", signerGrid)
const last = await Promise.all(PORTS.map(p => nodeCall(p, "getLastBlock")))
const lastAt = (r: any) => `${r.response.number}:${r.response.hash}`
say(`   getLastBlock per node: ${last.map(lastAt).join("  ")}`)
const states = await settledStates()
check(states !== null && new Set(states).size === 1, "balances and nonces identical on all 4 nodes, read while all four tips agreed and held still")
const aliceRow = everyDb(`select balance||':'||nonce from gcr_main where pubkey='${ALICE}'`)
record("alice-per-node", aliceRow)
check(
    new Set(aliceRow).size === 1 && aliceRow[0].endsWith(`:${aliceNonce}`),
    `alice's nonce is ${aliceNonce} everywhere: exactly the three accepted transfers and nothing refused landed`,
)
const bobTotal = everyDb(`select balance from gcr_main where pubkey='${BOB}'`)
check(bobTotal.every(b => BigInt(b) === AMOUNT * 3n), `bob received exactly ${AMOUNT * 3n} (three transfers)`)

// ---- 6 and 7 --------------------------------------------------------------
let restartsAfterManual = restartsBaseline
if (!UPGRADE) {
step("a validator that boots without the fork schedule")
// A binary or genesis from before the forks schedules nothing. Node 4 gets
// exactly that: its genesis loses both entries, then it restarts.
const peerGenesis = readFileSync(`${RUN_DIR}/data/genesis.node1.json`, "utf8")
const genesis4 = JSON.parse(peerGenesis)
delete genesis4.forks.signatureDomain
delete genesis4.forks.web2ProofBinding
// In place, so the container's bind mount sees it.
writeFileSync(`${RUN_DIR}/data/genesis.node4.json`, JSON.stringify(genesis4, null, 2) + "\n")
execFileSync(DOCKER, ["restart", `${PROJECT}-node-4`])
// Taken after the restart returns, so the old process's last lines and its kill
// event fall before both marks.
const restartedAt = new Date().toISOString()
const restartedEpoch = Math.floor(Date.now() / 1000)
// A manual restart zeroes the engine's restart counter; count from here.
restartsAfterManual = restartCounts()
const back = await until(async () => (await tipOf(PORTS[3])) >= common - 1, 150, 3000)
check(back, "node 4 restarted and is serving again")
// The hash comparison happens during peer bootstrap, some seconds after the RPC is up.
const mismatchSeen = await until(() => /Genesis data hash does not match/.test(nodeLog(4, restartedAt)), 90, 2000)
check(
    mismatchSeen,
    "node 4's bootstrap found its genesis hash different from its peers': the fork schedule is part of the genesis hash",
)
const healedFile = () => JSON.parse(readFileSync(`${RUN_DIR}/data/genesis.node4.json`, "utf8"))
const healed = await until(() => healedFile().forks.signatureDomain?.activationHeight === H, 30, 1000)
check(healed, "node 4 overwrote its own genesis file with the peer's, fork entries included")
const info4 = (await nodeCall(PORTS[3], "getNetworkInfo")).response
record("getNetworkInfo-node4", info4.forks.signatureDomain)
check(
    info4.forks.signatureDomain.activationHeight === null,
    "yet the running node 4 still reports signatureDomain unscheduled: the schedule was read before the file was replaced",
)

const tipsBefore = await Promise.all(PORTS.map(tipOf))
say(`   tips before the split transactions: ${tipsBefore.join(", ")}`)
await until(async () => (await tipOf(PORTS[3])) >= Math.min(...(await Promise.all(PORTS.slice(0, 3).map(tipOf)))) - 1, 90, 2000)
const carol = await client(PORTS[0], "carol")
const carol4 = await client(PORTS[3], "carol")
const demos4 = await client(PORTS[3], "alice")
const splitBase = await fresh.pay(BOB, AMOUNT)
const splitDomain = await signAs(fresh, splitBase, { chainId: CHAIN_ID })
const carolBase = await carol.pay(BOB, AMOUNT)
const carolLegacy = await signAs(carol, carolBase, "legacy")

const r4Domain = await submit(demos4, splitDomain)
record("domain-signed-to-node4", r4Domain)
check(!r4Domain.accepted, `node 4 refuses a domain-signed transfer (at ${r4Domain.stage})`)
const r1Domain = await submit(fresh, splitDomain)
record("domain-signed-to-node1", r1Domain)
check(r1Domain.accepted, "node 1 accepts the very same domain-signed transfer")
const r1Legacy = await submit(carol, carolLegacy)
record("legacy-signed-to-node1", r1Legacy)
check(!r1Legacy.accepted, "node 1 refuses a legacy-signed transfer")
const r4Legacy = await submit(carol4, carolLegacy)
record("legacy-signed-to-node4", r4Legacy)
check(r4Legacy.accepted, "node 4 accepts the very same legacy-signed transfer: the admission rules now disagree")

// Node 4 keeps being drawn into shards with a candidate block nobody else agrees
// with; after three such draws its stall watchdog ends the process.
const stalled = await until(() => /Missed 3 consecutive shard selections.*exiting for log investigation/.test(nodeLog(4, restartedAt)), 180, 3000)
check(stalled, "node 4 logged the stall watchdog's exit after three shard draws without its signature")
const log4s = nodeLog(4, restartedAt)
const stallBlocks = [...log4s.matchAll(/Drawn into the shard for block (\d+) but our signature is missing/g)].map(m => Number(m[1]))
const refusedCandidates = (log4s.match(/Hash does not correspond to our candidate block/g) ?? []).length
say(`   node 4 log since the restart: ${refusedCandidates} candidate-block refusals by peers; missing-signature stalls at blocks ${stallBlocks.join(", ")}`)
check(
    refusedCandidates > 0 && stallBlocks.length >= 3,
    "peers refused node 4's candidate blocks, and it was drawn into at least three shards without signing",
)
const incl = landed(splitBase.hash)
record("split-tx-block-per-node", incl)
const majorityBlock = incl.slice(0, 3).find(b => b !== null) ?? null
check(
    majorityBlock !== null && incl.slice(0, 3).every(b => b === majorityBlock),
    `nodes 1-3 included the domain-signed transfer in block ${majorityBlock}`,
)
check(
    incl[3] === majorityBlock,
    "node 4 still stored that block: block sync trusts the quorum's signatures and does not re-check transaction signatures",
)
const stallSigners = stallBlocks.map(n => ({ n, signers: signersOf(n).length, node4: signersOf(n).includes(NODE4_KEY) }))
record("signers-per-stall-block", stallSigners)
check(
    stallSigners.every(b => !b.node4 && b.signers === 3),
    `the blocks node 4 was drawn into (${stallBlocks.join(", ")}) were signed by the other 3 validators; none carries node 4's signature`,
)
const legacyLanded = landed(carolBase.hash)
record("legacy-tx-block-per-node", legacyLanded)
check(legacyLanded.every(b => b === null), "the legacy-signed transfer accepted only by node 4 landed in no block on any node")
record(
    "node4-log-evidence",
    log4s
        .split("\n")
        .filter(l => /Hash does not correspond|STALL DETECTION|Genesis data hash does not match|Block is invalid/.test(l))
        .slice(-8)
        .map(l => l.slice(0, 220)),
)

// ---- 7 ---------------------------------------------------------------------
step("recovery: the engine restarts the validator and it reads the corrected genesis")
const exits = () =>
    readFileSync(`${RUN_DIR}/logs/docker-events.log`, "utf8")
        .split("\n")
        .filter(l => / die forkrehearsal-node-4 exit=0/.test(l) && Number(l.split(" ")[0]) >= restartedEpoch)
check(
    await until(() => exits().length === 1, 30, 1000),
    "the engine saw exactly one exit with code 0 from node 4 since its manual restart: the watchdog's process.exit(0)",
)
const reloaded = await until(
    () => new RegExp(`Loaded fork "signatureDomain" with activationHeight=${H}`).test(nodeLog(4, restartedAt)),
    120,
    3000,
)
check(reloaded, `the restarted node 4 loaded signatureDomain at ${H} from the genesis it had downloaded`)
const info4b = await until(
    async () => {
        try {
            return (await nodeCall(PORTS[3], "getNetworkInfo")).response.forks.signatureDomain.activationHeight === H
        } catch {
            return false
        }
    },
    90,
    3000,
)
check(info4b, `node 4 reports signatureDomain at ${H} again`)
const tipTarget = async () => Math.min(...(await Promise.all(PORTS.slice(0, 3).map(tipOf))))
check(await until(async () => (await tipOf(PORTS[3])) >= (await tipTarget()) - 1, 180, 3000), "node 4 catches up with the quorum")
const stateAfter = await settledStates()
check(stateAfter !== null && new Set(stateAfter).size === 1, "balances and nonces identical on all 4 nodes again")
const refusalsAtCatchUp = (nodeLog(4, restartedAt).match(/Hash does not correspond to our candidate block/g) ?? []).length
const tipAtCatchUp = Math.min(...(await Promise.all(PORTS.map(tipOf))))
await until(async () => Math.min(...(await Promise.all(PORTS.map(tipOf)))) >= tipAtCatchUp + 4, 120, 3000)
const common2 = Math.min(...(await Promise.all(PORTS.map(tipOf))))
const heights2 = Array.from({ length: common2 - (majorityBlock! - 2) + 1 }, (_, i) => majorityBlock! - 2 + i)
const grid2 = await Promise.all(heights2.map(async n => ({ n, hashes: await Promise.all(PORTS.map(p => hashAt(p, n))) })))
record("block-hashes-after-recovery", grid2)
check(
    grid2.every(g => g.hashes.every(h => h !== null && h === g.hashes[0])),
    `block hashes identical on all 4 nodes for blocks ${heights2[0]}..${common2}, from before the split to after the recovery`,
)
const stillRefused = (nodeLog(4, restartedAt).match(/Hash does not correspond to our candidate block/g) ?? []).length
const mempool4 = sql("node4_db", `select count(*) from mempooltx where hash='${carolBase.hash}'`)
record("recovery-observation", { refusalsAtCatchUp, stillRefused, legacyTxInMempool: mempool4 })
say(`   candidate-block refusals in node 4's log: ${refusalsAtCatchUp} up to the catch-up, ${stillRefused} four blocks later; legacy-signed transfer in node 4's mempool table: ${mempool4}`)
check(mempool4 === "0", "the legacy-signed transfer only node 4 had admitted is gone from its mempool after the restart")
const tail7 = Array.from({ length: 2 }, (_, i) => common2 - 1 + i).map(n => ({ n, signers: signersOf(n).length, node4: signersOf(n).includes(NODE4_KEY) }))
record("signers-per-block-after-recovery", tail7)
check(tail7.every(b => b.signers === 4 && b.node4), `blocks ${tail7[0].n} and ${tail7[1].n}, four blocks after the catch-up, carry all four signatures, node 4's again`)

}

step("container health")
const endRestarts = restartCounts()
record("restart-counts-and-oom", { atScenarioStart: restartsBaseline, afterManualRestart: restartsAfterManual, atEnd: endRestarts })
if (existsSync(`${RUN_DIR}/logs/docker-events.log`)) {
    record(
        "engine-events",
        readFileSync(`${RUN_DIR}/logs/docker-events.log`, "utf8")
            .trim()
            .split("\n")
            .filter(l => !/ exec_/.test(l) && /node-4|oom/.test(l))
            .slice(-14),
    )
}
if (UPGRADE) {
    check(
        endRestarts.every((h, i) => h === restartsBaseline[i] && h.endsWith("false")),
        "no node was restarted by the engine or killed for memory after the last restart this scenario issued",
    )
} else {
    check(
        [0, 1, 2].every(i => endRestarts[i] === restartsBaseline[i]) && endRestarts.every(h => h.endsWith("false")),
        "nodes 1-3 were never restarted and no container was killed for memory while the scenario ran",
    )
    check(
        endRestarts[3] === `${Number(restartsAfterManual[3].split(" ")[0]) + 1} false`,
        "node 4 was restarted by the engine exactly once after the manual restart: the stall exit",
    )
}

say(process.exitCode ? "\nREHEARSAL FAILED" : "\nREHEARSAL PASSED")
process.exit(process.exitCode ?? 0)
