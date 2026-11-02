/**
 * Scenario for validators that run with different fork schedules. Start it with
 * MISMATCH=1 or MISMATCH=2 ./rehearsal.sh, which brings up the 4-validator devnet
 * with both forks at ACTIVATION_HEIGHT and sets the environment this reads.
 *
 * Steps (each writes its own log and raw responses under $RUN_DIR/steps):
 *   1  the last MISMATCH validators move web2ProofBinding to MINORITY_HEIGHT while
 *      that is still beyond tip + 50; the boot check accepts such an edit
 *   2  the schedule watch finds the difference once the window opens
 *      MISMATCH=1: only the odd validator abstains; the other three report it
 *      MISMATCH=2: no side is a majority from where it stands, so every validator abstains
 *   3  what the chain does meanwhile
 *      MISMATCH=1: the three forge on without the fourth, which keeps syncing
 *      MISMATCH=2: the chain stops, and every node holds the same blocks
 *   4  a further local edit inside the window is refused at boot
 *   5  the operators put the agreed schedule back and the network is whole again
 *   6  the fork activates on every validator at the same block
 *   7  no container ran out of memory
 *
 * Only web2ProofBinding moves, so both sides have the same nearest height and
 * enter the window together; otherwise the side that enters first could stop
 * the chain before the other side ever compares.
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const env = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`${k} must be set; run this through MISMATCH=1|2 rehearsal.sh`)
    return v
}
const RUN_DIR = env("RUN_DIR")
const PROJECT = env("PROJECT")
const MISMATCH = Number(env("MISMATCH"))
if (MISMATCH !== 1 && MISMATCH !== 2) throw new Error("MISMATCH must be 1 or 2")
const H = Number(env("ACTIVATION_HEIGHT"))
const MINORITY_H = Number(env("MINORITY_HEIGHT"))
const BLOCK_SECS = Number(env("CONSENSUS_TIME"))
const PORTS = [53551, 53553, 53555, 53557]
const NODES = [1, 2, 3, 4]
const MINORITY = NODES.slice(4 - MISMATCH)
const MAJORITY = NODES.slice(0, 4 - MISMATCH)
const pubkey = (n: number) =>
    readFileSync(`${RUN_DIR}/data/identities/node${n}.pubkey`, "utf8").trim().toLowerCase().replace(/^0x/, "")

const DOCKER = ["/usr/bin/docker", "/usr/local/bin/docker"].find(existsSync)
if (!DOCKER) throw new Error("docker not found at /usr/bin or /usr/local/bin")

// ---- reporting -------------------------------------------------------------

let stepNo = 0
let stepFile = `${RUN_DIR}/steps/00-setup.log`
mkdirSync(`${RUN_DIR}/steps`, { recursive: true })
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
function record(label: string, value: unknown) {
    const text = JSON.stringify(value, null, 2)
    writeFileSync(`${stepFile.replace(/\.log$/, "")}.${label.replace(/\W+/g, "-")}.json`, text + "\n")
    say(`   ${label}: ${text.replace(/\s+/g, " ").slice(0, 600)}`)
}

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
    const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data, muid: "mismatch" }] }),
        signal: AbortSignal.timeout(8000),
    })
    return (await res.json()) as { result: number; response: any }
}
const tipOf = async (n: number) => {
    try {
        const r = await nodeCall(PORTS[n - 1], "getLastBlockNumber")
        return typeof r.response === "number" ? r.response : -1
    } catch {
        return -1
    }
}
const tips = () => Promise.all(NODES.map(tipOf))
const hashAt = async (n: number, height: number) => {
    try {
        const r = await nodeCall(PORTS[n - 1], "getBlockByNumber", { blockNumber: height })
        return r.result === 200 ? (r.response.hash as string) : null
    } catch {
        return null
    }
}
const sql = (n: number, q: string) =>
    execFileSync(DOCKER, ["exec", `${PROJECT}-postgres`, "psql", "-U", "demosuser", "-d", `node${n}_db`, "-Atc", q])
        .toString()
        .trim()
/** Validators whose signatures sit in the stored block, from node 1's database. */
const signersOf = (height: number): string[] => {
    const raw = sql(1, `select validation_data::text from blocks where number=${height}`)
    return raw ? Object.keys(JSON.parse(raw).signatures ?? {}).map(k => k.toLowerCase().replace(/^0x/, "")) : []
}
const acceptedDigest = (n: number) => sql(n, `select digest from accepted_fork_schedule limit 1`)
const nodeLog = (n: number, since?: string) =>
    execFileSync(DOCKER, ["logs", ...(since ? ["--since", since] : []), `${PROJECT}-node-${n}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
    }).replace(/\u001b\[[0-9;]*m/g, "")
const linesWith = (text: string, needle: string) => text.split("\n").filter(l => l.includes(needle))
/** One gauge from the node's own metrics endpoint, read inside its container. */
function gauge(n: number, name: string): number | null {
    try {
        const text = execFileSync(
            DOCKER,
            ["exec", `${PROJECT}-node-${n}`, "bun", "-e",
                "fetch('http://127.0.0.1:9090/metrics').then(r => r.text()).then(t => process.stdout.write(t))"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
        )
        const line = text.split("\n").find(l => !l.startsWith("#") && new RegExp(`(^|_)${name}(\\{[^}]*\\})?\\s`).test(l))
        return line ? Number(line.trim().split(/\s+/).pop()) : null
    } catch {
        return null
    }
}
const gauges = (name: string) => NODES.map(n => gauge(n, name))
const restartNode = (n: number) => execFileSync(DOCKER, ["restart", "-t", "5", `${PROJECT}-node-${n}`])
const oomKilled = () =>
    NODES.map(n => execFileSync(DOCKER, ["inspect", "-f", "{{.State.OOMKilled}}", `${PROJECT}-node-${n}`]).toString().trim())

const genesisPath = (n: number) => `${RUN_DIR}/data/genesis.node${n}.json`
function writeSchedule(n: number, height: number, web2Height = height) {
    const g = JSON.parse(readFileSync(genesisPath(n), "utf8"))
    g.forks.signatureDomain = { activationHeight: height }
    g.forks.web2ProofBinding = { activationHeight: web2Height }
    // In place, so the container's bind mount sees it.
    writeFileSync(genesisPath(n), JSON.stringify(g, null, 2) + "\n")
}
const ABSTAIN = "[FORK SCHEDULE] Abstaining from consensus from block"
const RESUME = "[FORK SCHEDULE] No majority of validators differs"
const loadedLine = (height: number, fork = "signatureDomain") => `Loaded fork "${fork}" with activationHeight=${height}`

say(`== schedule mismatch: ${MISMATCH} of 4 validators (nodes ${MINORITY.join(", ")}) move web2ProofBinding to ${MINORITY_H}; every fork is at ${H} on the others`)
const startedAt = new Date().toISOString()

// ---- 1 ---------------------------------------------------------------------
step(`nodes ${MINORITY.join(", ")} move web2ProofBinding to ${MINORITY_H} beyond tip + 50`)
const bootLogs = NODES.map(n => nodeLog(n))
check(
    NODES.every(n => bootLogs[n - 1].includes(loadedLine(H)) && bootLogs[n - 1].includes(loadedLine(H, "web2ProofBinding"))),
    `every node booted with both forks at ${H}`,
)
const tipAtMove = await tipOf(1)
check(tipAtMove >= 0 && tipAtMove + 50 < H, `the edit lands at tip ${tipAtMove}, while both ${H} and ${MINORITY_H} still lie beyond tip + 50`)
for (const n of MINORITY) writeSchedule(n, H, MINORITY_H)
for (const n of MINORITY) restartNode(n)
const movedAt = new Date().toISOString()
const movedBack = await until(async () => (await Promise.all(MINORITY.map(tipOf))).every(t => t >= tipAtMove), 180, 3000)
check(
    movedBack &&
        MINORITY.every(n => {
            const log = nodeLog(n, movedAt)
            return log.includes(loadedLine(MINORITY_H, "web2ProofBinding")) &&
                log.includes("Fork schedule change accepted at tip") &&
                !log.includes("Refusing to boot")
        }),
    `nodes ${MINORITY.join(", ")} restarted with web2ProofBinding at ${MINORITY_H}, accepted by the boot check without an override`,
)
const digestsAfterMove = NODES.map(acceptedDigest)
record("accepted-digests", digestsAfterMove)
check(
    MINORITY.every(n => digestsAfterMove[n - 1] !== digestsAfterMove[0]) &&
        MAJORITY.every(n => digestsAfterMove[n - 1] === digestsAfterMove[0]),
    "the odd validators now hold a different accepted schedule",
)

// ---- 2 ---------------------------------------------------------------------
step("the schedule watch finds the difference inside the window")
const expectedAbstainers = MISMATCH === 1 ? MINORITY : NODES
// The window opens at H - 50 and the watch compares every 10 blocks inside it.
const detected = await until(
    () => expectedAbstainers.every(n => nodeLog(n).includes(ABSTAIN)),
    Math.max(0, H - 50 + 10 - (await tipOf(1))) * BLOCK_SECS * 2 + 180,
    5000,
)
check(detected, `nodes ${expectedAbstainers.join(", ")} logged that they abstain from consensus`)
const abstainLines = Object.fromEntries(NODES.map(n => [`node${n}`, linesWith(nodeLog(n), ABSTAIN).map(l => l.slice(0, 500))]))
record("abstain-lines", abstainLines)
const firstAbstainBlock = (n: number) => {
    const line = linesWith(nodeLog(n), ABSTAIN)[0] ?? ""
    const m = line.match(/from block (\d+)/)
    return m ? Number(m[1]) : null
}
if (MISMATCH === 1) {
    const [odd] = MINORITY
    check(
        linesWith(nodeLog(odd), ABSTAIN).some(l => l.includes("(3 of 3 validators)") && l.includes(`nearest scheduled height ${H}`)),
        `node ${odd}'s reason names all 3 peers as differing and the nearest height ${H}`,
    )
    const oddUrl = `node-${odd}:${PORTS[odd - 1]}`
    check(
        MAJORITY.every(n => linesWith(nodeLog(n), "[FORK SCHEDULE] MISMATCH with").some(l => l.includes(oddUrl))),
        `nodes ${MAJORITY.join(", ")} each reported the mismatch with node ${odd} (${oddUrl})`,
    )
    // At start-up a majority node can briefly see only the odd peer; that abstain
    // must clear on its own and is recorded, not failed.
    record(
        "majority-transient-abstains",
        MAJORITY.map(n => ({ node: n, abstained: linesWith(nodeLog(n), ABSTAIN).length, resumed: linesWith(nodeLog(n), RESUME).length })),
    )
    let abstaining: (number | null)[] = []
    const settled = await until(() => {
        abstaining = gauges("consensus_abstaining")
        return abstaining.every((v, i) => v === (MINORITY.includes(i + 1) ? 1 : 0))
    }, 180, 10000)
    record("consensus_abstaining", abstaining)
    check(settled, `consensus_abstaining is 1 on node ${odd} only and 0 on nodes ${MAJORITY.join(", ")}`)
    const mismatch = gauges("fork_schedule_mismatch")
    record("fork_schedule_mismatch", mismatch)
    check(mismatch.every(v => v === 1), "fork_schedule_mismatch is 1 on all four nodes, so every operator is alerted")
} else {
    check(
        NODES.every(n => linesWith(nodeLog(n), ABSTAIN).some(l => l.includes("(2 of 3 validators)"))),
        "every node's reason counts 2 of its 3 peers as differing: each side sees itself outnumbered",
    )
    const abstaining = gauges("consensus_abstaining")
    record("consensus_abstaining", abstaining)
    check(abstaining.every(v => v === 1), "consensus_abstaining is 1 on all four nodes")
    const mismatch = gauges("fork_schedule_mismatch")
    record("fork_schedule_mismatch", mismatch)
    check(mismatch.every(v => v === 1), "fork_schedule_mismatch is 1 on all four nodes")
}

// ---- 3 ---------------------------------------------------------------------
step(MISMATCH === 1 ? "the three forge on without the fourth" : "the chain stops, and every node holds the same blocks")
if (MISMATCH === 1) {
    const [odd] = MINORITY
    const from = Math.max(firstAbstainBlock(odd) ?? 0, await tipOf(1))
    const advanced = await until(async () => (await tipOf(1)) >= from + 5, BLOCK_SECS * 5 * 4 + 60, 3000)
    const to = await tipOf(1)
    check(advanced, `node 1's tip moved from ${from} to ${to} while node ${odd} abstained`)
    const range = Array.from({ length: Math.max(0, to - from) }, (_, i) => from + 1 + i)
    const signed = range.map(h => ({ h, signers: signersOf(h).length, odd: signersOf(h).includes(pubkey(odd)) }))
    record("signers-after-abstain", signed)
    check(range.length > 0 && signed.every(s => !s.odd), `node ${odd} signed none of blocks ${from + 1}..${to}`)
    check(signed.every(s => s.signers >= 3), "every one of those blocks carries at least 3 signatures")
    const synced = await until(async () => (await tipOf(odd)) >= to, BLOCK_SECS * 3 + 30, 2000)
    const [h1, hOdd] = await Promise.all([hashAt(1, to), hashAt(odd, to)])
    record("hash-at-" + to, { node1: h1, [`node${odd}`]: hOdd })
    check(synced && h1 !== null && h1 === hOdd, `node ${odd} kept syncing: it holds block ${to} with node 1's hash`)
} else {
    let before: number[] = []
    const quiet = await until(async () => {
        before = await tips()
        await sleep(BLOCK_SECS * 6 * 1000)
        const after = await tips()
        return before.every(t => t >= 0) && after.every((t, i) => t === before[i])
    }, BLOCK_SECS * 6 * 4 + 60, 1000)
    record("tips-while-stopped", before)
    check(quiet, `no node's tip moved for ${BLOCK_SECS * 6} s (${before.join(", ")}): the chain stopped instead of splitting`)
    const common = Math.min(...before)
    const hashes = await Promise.all(NODES.map(n => hashAt(n, common)))
    record("hash-at-" + common, hashes)
    check(hashes.every(h => h !== null && h === hashes[0]), `all four nodes hold the same block ${common}`)
}

// ---- 4 ---------------------------------------------------------------------
step("a further local edit inside the window is refused at boot")
const edited = MINORITY[MINORITY.length - 1]
const digestBefore = acceptedDigest(edited)
const tipAtEdit = await tipOf(1)
// Below H, so it lands inside tip + 50 even where the chain stopped as the window opened.
const badHeight = H - 2
check(badHeight > tipAtEdit && badHeight <= tipAtEdit + 50, `height ${badHeight} lies between tip ${tipAtEdit} and tip + 50`)
writeSchedule(edited, H, badHeight)
restartNode(edited)
const editAt = new Date().toISOString()
const refused = await until(() => nodeLog(edited, editAt).includes("[GENESIS] Refusing to boot: fork schedule in data/genesis.json differs"), 120, 3000)
const refusal = linesWith(nodeLog(edited, editAt), "Refusing to boot").slice(0, 2).map(l => l.slice(0, 700))
record("refusal", refusal)
check(refused, `node ${edited} refused to boot on web2ProofBinding moved again, to ${badHeight}, at tip ${tipAtEdit}`)
check(
    refusal.some(l => l.includes(`touches height`) && /DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST=[0-9a-f]{64}/.test(l)),
    "the refusal names the height it touches and the digest an operator would have to name",
)
check(acceptedDigest(edited) === digestBefore, `node ${edited}'s accepted schedule in its database is unchanged`)

// ---- 5 ---------------------------------------------------------------------
step("the operators put the agreed schedule back")
for (const n of MINORITY) writeSchedule(n, H)
for (const n of MINORITY) restartNode(n)
const fixedAt = new Date().toISOString()
const fixedTip = await tipOf(1)
const rejoined = await until(
    async () => (await Promise.all(MINORITY.map(tipOf))).every(t => t >= fixedTip),
    180,
    3000,
)
check(rejoined, `nodes ${MINORITY.join(", ")} are serving again at or above tip ${fixedTip}`)
check(
    MINORITY.every(n => {
        const log = nodeLog(n, fixedAt)
        return log.includes(loadedLine(H, "web2ProofBinding")) && log.includes("accepted by DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST=")
    }),
    `nodes ${MINORITY.join(", ")} loaded height ${H}, the change inside the window accepted only because the operator named that exact schedule`,
)
if (MISMATCH === 2) {
    const resumed = await until(() => MAJORITY.every(n => nodeLog(n, fixedAt).includes(RESUME)), 180, 5000)
    check(resumed, `nodes ${MAJORITY.join(", ")} found no majority differing any more and resumed consensus on their own`)
}
let abstainingAfter: (number | null)[] = []
const allIn = await until(() => {
    abstainingAfter = gauges("consensus_abstaining")
    return abstainingAfter.every(v => v === 0)
}, 240, 10000)
record("consensus_abstaining", abstainingAfter)
check(allIn, "consensus_abstaining is 0 on all four nodes")
const digests = NODES.map(acceptedDigest)
record("accepted-digests", digests)
check(digests.every(d => d !== "" && d === digests[0]), "all four databases hold the same accepted schedule")
const fromTip = await tipOf(1)
const moving = await until(async () => (await tipOf(1)) >= fromTip + 3, BLOCK_SECS * 3 * 4 + 60, 3000)
check(moving, `the chain moves again past block ${fromTip}`)
let signedAgain = false
await until(async () => {
    const tip = await tipOf(1)
    for (let h = fromTip + 1; h <= tip; h++) {
        const signers = signersOf(h)
        if (MINORITY.every(n => signers.includes(pubkey(n)))) {
            signedAgain = true
            record("first-block-signed-by-the-corrected", { height: h, signers: signers.length })
            return true
        }
    }
    return false
}, BLOCK_SECS * 10 + 60, 5000)
check(signedAgain, `nodes ${MINORITY.join(", ")} sign blocks again`)

// ---- 6 ---------------------------------------------------------------------
step(`the fork activates on every validator at block ${H}`)
const past = await until(async () => (await tips()).every(t => t >= H + 2), Math.max(0, H + 2 - (await tipOf(1))) * BLOCK_SECS * 3 + 180, 5000)
check(past, `every node's tip passed ${H + 2}`)
for (const height of [H - 1, H, H + 1]) {
    const hashes = await Promise.all(NODES.map(n => hashAt(n, height)))
    record(`hash-at-${height}`, hashes)
    check(hashes.every(h => h !== null && h === hashes[0]), `all four nodes hold the same block ${height}`)
}

// ---- 7 ---------------------------------------------------------------------
step("resources")
const oom = oomKilled()
record("oom-killed", oom)
check(oom.every(v => v === "false"), "no container was killed for memory")
record(
    "stall-detection-lines-since-start",
    NODES.map(n => ({ node: n, missing: linesWith(nodeLog(n, startedAt), "[STALL DETECTION]").length })),
)

say(process.exitCode ? "\nREHEARSAL FAILED" : "\nREHEARSAL PASSED")
process.exit(process.exitCode ?? 0)
