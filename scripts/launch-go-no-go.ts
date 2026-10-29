/**
 * Launch go/no-go check.
 *
 * Probes every launch validator and decides GO only when at least q
 * members of the first block's bound committee (q = 2/3 + 1 of shardSize,
 * the block quorum) are online on one genesis hash, no operator or cloud
 * provider holds more launch validators than the committee can lose
 * (shardSize - q), the genesis schedules the mainnet forks at block 0, and
 * no launch validator is a pinned committee identity. A validator counts
 * only after its endpoint signs a fresh nonce with the validator's key (the
 * node's own hello handshake); what /info claims is never enough. See
 * docs/runbooks/launch-go-no-go.md.
 *
 *   bun scripts/launch-go-no-go.ts --genesis data/genesis.json \
 *       --operators operators.json --snapshot data/snapshot \
 *       [--peerlist demos_peerlist.json] [--rpc URL[,URL...]] \
 *       [--genesis-hash HASH] [--commit SHA] [--json]
 *
 * operators.json maps each validator identity to { operator, provider }.
 * Exit codes: 0 GO, 1 NO-GO, 2 bad input.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"
import { drawBoundCommittee } from "src/libs/consensus/v2/routines/getShard"
import { compareIdentities } from "src/libs/consensus/v2/routines/peerlistMerge"
import Hashing from "src/libs/crypto/hashing"
import type { ForkName } from "src/forks/forkConfig"
import { PINNED_SHARD_IDENTITIES } from "src/utilities/constants"
import {
    type BlockZeroValidators,
    type ValidatorRow,
    activeAtBlockZero,
    launchIdentities,
    readBlockZeroValidators,
} from "./launch-validator-set"

export interface OperatorEntry {
    operator: string
    provider: string
}

export interface ValidatorProbe {
    /** Launch identity this probe was made for (from the genesis), or the one /info reported. */
    identity: string
    url: string
    reachable: boolean
    /** Identity the endpoint reports in /info. */
    reportedIdentity?: string | null
    genesisHash?: string | null
    head?: number | null
    commit?: string | null
    version?: string | null
    /**
     * Outcome of the signed-nonce challenge: "verified" only when the
     * endpoint signed our fresh nonce with this identity's key.
     */
    identityProof?: IdentityProof | null
    error?: string | null
}

export type IdentityProof = "verified" | "unsigned" | "invalid" | "failed"

export interface GoNoGoInput {
    shardSize: number
    launchValidators: string[]
    probes: ValidatorProbe[]
    operators: Record<string, unknown> | null
    expectedGenesisHash?: string | null
    expectedCommit?: string | null
    /**
     * Bound committee of block 1 (see firstCommittee). Without it only a
     * launch set no larger than shardSize can be checked, since then the
     * committee is every launch validator.
     */
    committee?: string[] | null
}

export type ValidatorStatus =
    | "counted"
    | "unreachable"
    | "wrong-identity"
    | "unproven-identity"
    | "no-genesis"
    | "other-genesis"
    | "other-commit"
    | "not-probed"

export interface GoNoGoDecision {
    go: boolean
    quorum: number
    launchCount: number
    genesisHash: string | null
    counted: string[]
    /** Counted validators that sit in the first committee: the ones GO needs. */
    countedInCommittee: string[]
    committee: string[] | null
    reasons: string[]
    warnings: string[]
    validators: Array<{
        identity: string
        status: ValidatorStatus
        url: string | null
        head: number | null
        commit: string | null
        operator: string | null
        provider: string | null
        inCommittee: boolean | null
    }>
    operatorCounts: Record<string, number>
    providerCounts: Record<string, number>
    /** Most validators any single operator or provider may hold: the committee seats q can spare. */
    groupCap: number
}

/** Forks a mainnet genesis must switch on at block 0. */
export const MAINNET_FORKS: readonly ForkName[] = [
    "signatureDomain",
    "editBinding",
    "quorumParity",
    "committeeBinding",
    "commitLock",
]

const norm = (id: string) => id.trim().toLowerCase()
/** Operator and provider names are free text typed by people. */
const groupName = (name: string) => name.trim().toLowerCase()
/** Genesis hashes compare without case or a 0x prefix. */
export const normHash = (hash: string) => hash.trim().toLowerCase().replace(/^0x/, "")

function isOperatorEntry(entry: unknown): entry is OperatorEntry {
    if (entry === null || typeof entry !== "object") return false
    const { operator, provider } = entry as Record<string, unknown>
    return (
        typeof operator === "string" &&
        operator.trim().length > 0 &&
        typeof provider === "string" &&
        provider.trim().length > 0
    )
}

/**
 * Seed of block 1's committee: the common validator seed of block 0,
 * where the last-three-blocks window holds block 0 alone.
 */
export function firstCommitteeSeed(genesisHash: string): string {
    return Hashing.sha256(`${genesisHash}:0|genesis:${genesisHash}`)
}

/**
 * Bound committee of block 1, from the genesis file and the genesis block
 * hash. Block 0 commits no peerlist, so the pool is the staked set at
 * block 0 (status "2", valid at 0), ordered as the node orders it, and the
 * draw is the node's own.
 */
export function firstCommittee(
    validators: ValidatorRow[],
    genesisHash: string,
    shardSize: number,
): string[] {
    const pool = [...new Set(activeAtBlockZero(validators).map(v => String(v.address)))].sort(compareIdentities)
    return drawBoundCommittee(firstCommitteeSeed(normHash(genesisHash)), pool, shardSize).map(norm)
}

function countBy(ids: string[], key: (id: string) => string | null): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const id of ids) {
        const k = key(id)
        if (k === null) continue
        counts[k] = (counts[k] ?? 0) + 1
    }
    return counts
}

/**
 * The go/no-go rule as a pure function of the probes, so it can be tested
 * without a network.
 */
export function decideGoNoGo(input: GoNoGoInput): GoNoGoDecision {
    const quorum = quorumThreshold(input.shardSize)
    const launch = [...new Set(input.launchValidators.map(norm))]
    const reasons: string[] = []
    const warnings: string[] = []

    const operators = new Map<string, OperatorEntry>()
    const incomplete = new Set<string>()
    for (const [id, entry] of Object.entries(input.operators ?? {})) {
        if (isOperatorEntry(entry)) {
            operators.set(norm(id), { operator: groupName(entry.operator), provider: groupName(entry.provider) })
        } else {
            incomplete.add(norm(id))
        }
    }
    const probeOf = new Map<string, ValidatorProbe>()
    for (const probe of input.probes) {
        probeOf.set(norm(probe.identity), probe)
    }

    // Proven identities only, grouped by the genesis they report
    const online = launch.filter(id => {
        const p = probeOf.get(id)
        return (
            p?.reachable === true &&
            p.identityProof === "verified" &&
            typeof p.genesisHash === "string" &&
            p.genesisHash.length > 0
        )
    })
    const byGenesis = countBy(online, id => normHash(probeOf.get(id).genesisHash))
    let genesisHash: string | null = input.expectedGenesisHash ? normHash(input.expectedGenesisHash) : null
    if (genesisHash === null) {
        // Without an expected hash, the one most validators report; a tie
        // has no answer, so nothing is counted
        const ranked = Object.entries(byGenesis).sort((a, b) => b[1] - a[1])
        if (ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
            genesisHash = ranked[0][0]
        } else if (ranked.length > 1) {
            reasons.push(
                `validators split evenly between genesis hashes ${ranked.map(([h, n]) => `${h} (${n})`).join(", ")}`,
            )
        }
    }
    if (Object.keys(byGenesis).length > 1) {
        warnings.push(
            `validators report ${Object.keys(byGenesis).length} different genesis hashes: ` +
                Object.entries(byGenesis)
                    .map(([h, n]) => `${h} (${n})`)
                    .join(", "),
        )
    }

    const statusOf = (id: string): ValidatorStatus => {
        const p = probeOf.get(id)
        if (!p) return "not-probed"
        if (!p.reachable) return "unreachable"
        if (p.identityProof !== "verified") {
            // An unsigned claim never counts, whatever /info says
            if (typeof p.reportedIdentity === "string" && norm(p.reportedIdentity) !== id) {
                return "wrong-identity"
            }
            return "unproven-identity"
        }
        if (typeof p.genesisHash !== "string" || p.genesisHash.length === 0) return "no-genesis"
        if (genesisHash === null || normHash(p.genesisHash) !== genesisHash) return "other-genesis"
        if (input.expectedCommit && p.commit !== input.expectedCommit) return "other-commit"
        return "counted"
    }

    // With no more launch validators than shardSize the committee is all of them
    let committee: string[] | null = input.committee ? input.committee.map(norm) : null
    if (committee === null && launch.length <= input.shardSize) committee = launch
    const inCommittee = new Set(committee ?? [])

    const validators = launch.map(id => {
        const p = probeOf.get(id)
        const op = operators.get(id)
        return {
            identity: id,
            status: statusOf(id),
            url: p?.url ?? null,
            head: p?.head ?? null,
            commit: p?.commit ?? null,
            operator: op?.operator ?? null,
            provider: op?.provider ?? null,
            inCommittee: committee === null ? null : inCommittee.has(id),
        }
    })
    const counted = validators.filter(v => v.status === "counted").map(v => v.identity)
    const countedInCommittee = counted.filter(id => inCommittee.has(id))

    if (launch.length === 0) {
        reasons.push("no launch validators")
    }
    if (committee === null) {
        reasons.push(
            `the first committee is unknown (it needs the genesis file and an agreed genesis hash), ` +
                `and with ${launch.length} launch validators above shardSize ${input.shardSize} ` +
                "online launch validators do not show the chain can start",
        )
    } else {
        const outside = committee.filter(id => !launch.includes(id))
        if (outside.length > 0) {
            warnings.push(`${outside.length} first-committee members are not launch validators: ${outside.join(", ")}`)
        }
        if (countedInCommittee.length < quorum) {
            reasons.push(
                `${countedInCommittee.length} of the ${committee.length} members of the first committee are online ` +
                    `with a proven identity on genesis ${genesisHash ?? "(none agreed)"}` +
                    `${input.expectedCommit ? ` at commit ${input.expectedCommit}` : ""}; ` +
                    `need ${quorum} (2/3 + 1 of shardSize ${input.shardSize})`,
            )
        }
    }

    const commits = new Set(
        validators.filter(v => v.status === "counted" && v.commit).map(v => v.commit),
    )
    if (!input.expectedCommit && commits.size > 1) {
        warnings.push(`counted validators run ${commits.size} different commits: ${[...commits].join(", ")}`)
    }

    // The committee seats that can go dark with q still signing. The cap is
    // on the launch set: which of a group's validators the draw seats is
    // unknown until the genesis hash is, so all of them may be
    const groupCap = Math.max(0, Math.min(launch.length, input.shardSize) - quorum)
    const unmapped = launch.filter(id => !operators.has(id) && !incomplete.has(id))
    const badEntries = launch.filter(id => incomplete.has(id))
    if (input.operators === null) {
        reasons.push("no operator/provider map given; the operator cap cannot be checked")
    } else {
        if (unmapped.length > 0) {
            reasons.push(`${unmapped.length} launch validators have no operator/provider entry: ${unmapped.join(", ")}`)
        }
        if (badEntries.length > 0) {
            reasons.push(
                `${badEntries.length} launch validators have an incomplete entry (operator and provider must be ` +
                    `non-empty strings): ${badEntries.join(", ")}`,
            )
        }
    }
    const operatorCounts = countBy(launch, id => operators.get(id)?.operator ?? null)
    const providerCounts = countBy(launch, id => operators.get(id)?.provider ?? null)
    for (const [kind, counts] of [
        ["operator", operatorCounts],
        ["provider", providerCounts],
    ] as const) {
        for (const [name, n] of Object.entries(counts)) {
            if (n > groupCap) {
                reasons.push(
                    `${kind} ${name} runs ${n} of ${launch.length} launch validators; the cap is ${groupCap} ` +
                        `(shardSize ${input.shardSize} - quorum ${quorum})`,
                )
            }
        }
    }

    // A pinned identity takes a committee seat on any network whose pool
    // holds it, ahead of the draw
    const pinned = new Set(PINNED_SHARD_IDENTITIES.map(norm))
    for (const id of launch.filter(v => pinned.has(v))) {
        reasons.push(`launch validator is a pinned committee identity: ${id}`)
    }

    return {
        go: reasons.length === 0,
        quorum,
        launchCount: launch.length,
        genesisHash,
        counted,
        countedInCommittee,
        committee,
        reasons,
        warnings,
        validators,
        operatorCounts,
        providerCounts,
        groupCap,
    }
}

/** NO-GO reasons for a genesis that does not switch the mainnet forks on at block 0. */
export function mainnetForkReasons(genesis: { forks?: unknown } | null): string[] {
    if (!genesis) {
        return ["no genesis file: its fork schedule and block 0's validator set cannot be checked"]
    }
    const forks = (genesis.forks ?? {}) as Record<string, { activationHeight?: unknown } | undefined>
    return MAINNET_FORKS.filter(name => forks[name]?.activationHeight !== 0).map(
        name =>
            `fork ${name} is not scheduled at activationHeight 0 in the genesis ` +
            `(found ${JSON.stringify(forks[name]?.activationHeight ?? null)})`,
    )
}

export interface LaunchCheckInput extends Omit<GoNoGoInput, "launchValidators" | "committee"> {
    /** The parsed genesis file, or null when only endpoints were given. */
    genesis: { forks?: unknown; validators?: unknown } | null
    /** Block 0's validators as the node seeds them; required with a genesis. */
    blockZero: BlockZeroValidators | null
    /** The launch set when there is no genesis (peerlist or --rpc). */
    launchValidators?: string[]
}

/**
 * The whole check on the inputs the CLI gathers: the launch set is block
 * 0's staked validators, and the first committee is drawn from them under
 * the genesis hash the probes agree on (or the expected one).
 */
export function checkLaunch(input: LaunchCheckInput): GoNoGoDecision {
    const { genesis, blockZero, launchValidators, ...rest } = input
    const rows = genesis && blockZero ? blockZero.rows : null
    const base: GoNoGoInput = {
        ...rest,
        launchValidators: rows ? launchIdentities(rows) : (launchValidators ?? []),
    }
    const agreedHash = decideGoNoGo(base).genesisHash
    const committee = rows && agreedHash ? firstCommittee(rows, agreedHash, input.shardSize) : null
    const decision = decideGoNoGo({ ...base, committee })
    decision.reasons.push(...(blockZero?.reasons ?? []), ...mainnetForkReasons(genesis))
    decision.warnings.push(...(blockZero?.warnings ?? []))
    decision.go = decision.reasons.length === 0
    return decision
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliArgs {
    genesis: string | null
    snapshot: string | null
    peerlist: string | null
    operators: string | null
    rpc: string[]
    shardSize: number | null
    genesisHash: string | null
    commit: string | null
    json: boolean
    timeoutMs: number
}

function usage(): string {
    return [
        "usage: bun scripts/launch-go-no-go.ts --genesis FILE --operators FILE [options]",
        "  --genesis FILE       genesis JSON: launch validators, their URLs, shardSize and forks",
        "  --snapshot DIR       the snapshot directory the validators boot with; its validators.jsonl,",
        "                       when present, is block 0's validator set instead of the genesis list;",
        "                       without it the result is NO-GO",
        "  --peerlist FILE      identity -> URL map (demos_peerlist.json) overriding genesis URLs",
        "  --rpc URL[,URL...]   probe these URLs; each counts for the identity it proves by signing",
        "                       a fresh nonce; without --genesis they define the launch set",
        "  --shard-size N       shardSize when no genesis file is given",
        "  --operators FILE     identity -> { operator, provider }",
        "  --genesis-hash HASH  the agreed genesis block hash",
        "  --commit SHA         the agreed release commit (as /info reports it)",
        "  --timeout MS         per-request timeout (default 5000)",
        "  --json               machine-readable output",
    ].join("\n")
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        genesis: null,
        snapshot: null,
        peerlist: null,
        operators: null,
        rpc: [],
        shardSize: null,
        genesisHash: null,
        commit: null,
        json: false,
        timeoutMs: 5000,
    }
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]
        const value = () => {
            const v = argv[++i]
            if (v === undefined) throw new Error(`${flag} needs a value`)
            return v
        }
        switch (flag) {
            case "--genesis": args.genesis = value(); break
            case "--snapshot": args.snapshot = value(); break
            case "--peerlist": args.peerlist = value(); break
            case "--operators": args.operators = value(); break
            case "--rpc": args.rpc.push(...value().split(",").map(s => s.trim()).filter(Boolean)); break
            case "--shard-size": args.shardSize = Number(value()); break
            case "--genesis-hash": args.genesisHash = value(); break
            case "--commit": args.commit = value(); break
            case "--timeout": args.timeoutMs = Number(value()); break
            case "--json": args.json = true; break
            case "-h":
            case "--help":
                console.log(usage())
                return process.exit(0)
            default:
                throw new Error(`unknown argument ${flag}`)
        }
    }
    return args
}

async function fetchJson(url: string, timeoutMs: number, body?: unknown): Promise<any> {
    const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    return await res.json()
}

export interface IdentityProver {
    /** Has the endpoint at `url` sign a fresh nonce as `identity`. */
    prove(identity: string, url: string, genesisHash: string | null): Promise<{ proof: IdentityProof; detail: string | null }>
    stop(): Promise<void>
}

/**
 * The node's hello handshake as a client: the request carries a random
 * nonce, and the answer must be signed over DEMOS_PEER_AUTH_V1:<nonce>:<url>
 * by the expected identity, for the URL we dialed. Request and check are
 * the node's own (PeerManager.buildHelloRequest, verifyHelloResponse), with
 * a throwaway key: this machine needs no validator key, and the validator
 * cannot be made to sign anything else. The throwaway key advertises an
 * unroutable URL (TEST-NET-1, RFC 5737), so a validator's hello back to it
 * fails and it never adds this checker as a peer.
 */
export async function startIdentityProver(timeoutMs: number): Promise<IdentityProver> {
    const { Demos } = await import("@kynesyslabs/demosdk/websdk")
    const { getSharedState } = await import("src/utilities/sharedState")
    const PeerManager = (await import("src/libs/peer/PeerManager")).default
    const { Peer } = await import("src/libs/peer")
    const validatorPool = (await import("src/libs/blockchain/validation/txValidatorPool")).default
    const { CategorizedLogger } = await import("src/utilities/tui")
    // The node's own log lines would land on stdout in the middle of --json
    // output; each probe's result carries the reason instead
    CategorizedLogger.getInstance().enableTuiMode()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-no-go-"))
    fs.chmodSync(dir, 0o700)
    const identityFile = path.join(dir, "checker.identity")
    fs.writeFileSync(identityFile, new Demos().newMnemonic(), { mode: 0o600 })
    getSharedState.identityFile = identityFile
    // As the node boots: the hello request is signed with this keypair
    getSharedState.keypair = await getSharedState.identity.loadIdentity()
    getSharedState.exposedUrl = `http://192.0.2.1:${20000 + Math.floor(Math.random() * 40000)}`
    const pool = validatorPool.getInstance()
    await pool.start(1)

    return {
        async prove(identity, url, genesisHash) {
            const { request, nonce } = await PeerManager.buildHelloRequest()
            // Only the URL is signed in the request; the genesis lets a node
            // on that genesis answer at all
            if (genesisHash) request.genesisHash = genesisHash
            const peer = new Peer(url, identity)
            const response = await Promise.race([
                peer.call({ method: "hello_peer", params: [request] }, true),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`hello timed out after ${timeoutMs} ms`)), timeoutMs),
                ),
            ]).catch(e => ({ result: 0, response: (e as Error).message, extra: null }) as any)
            if (response.result !== 200) {
                const msg = response.extra?.msg ?? response.response
                return { proof: "failed", detail: `hello_peer ${response.result}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}` }
            }
            if (typeof response.extra?.msg === "string" && response.extra.msg.startsWith("Peer is us")) {
                return { proof: "invalid", detail: "the endpoint answered as this checker" }
            }
            const proof = await PeerManager.verifyHelloResponse(response, peer, nonce)
            return { proof, detail: proof === "verified" ? null : `identity proof ${proof}` }
        },
        async stop() {
            await pool.stop()
            fs.rmSync(dir, { recursive: true, force: true })
        },
    }
}

export async function probeValidator(
    identity: string,
    url: string,
    timeoutMs: number,
    prover: IdentityProver | null = null,
): Promise<ValidatorProbe> {
    const base = url.replace(/\/+$/, "")
    const probe: ValidatorProbe = { identity, url: base, reachable: false, identityProof: null }
    try {
        const info = await fetchJson(`${base}/info`, timeoutMs)
        probe.reachable = true
        probe.reportedIdentity = typeof info?.identity === "string" ? info.identity : null
        probe.commit = info?.commitHash ?? null
        probe.version = info?.version ?? null
        if (!identity) probe.identity = probe.reportedIdentity ?? base
    } catch (e) {
        probe.error = (e as Error).message
        return probe
    }
    try {
        const genesis = await fetchJson(`${base}/genesisBlock`, timeoutMs)
        probe.genesisHash = typeof genesis?.hash === "string" ? genesis.hash : null
    } catch (e) {
        probe.error = `genesis: ${(e as Error).message}`
    }
    try {
        const head = await fetchJson(base, timeoutMs, {
            method: "nodeCall",
            params: [{ message: "getLastBlockNumber", data: {}, muid: null }],
        })
        probe.head = head?.result === 200 ? Number(head.response) : null
    } catch (e) {
        probe.error = `${probe.error ? probe.error + "; " : ""}head: ${(e as Error).message}`
    }
    if (prover && /^0x[0-9a-f]{64}$/i.test(probe.identity)) {
        try {
            const { proof, detail } = await prover.prove(probe.identity, base, probe.genesisHash ?? null)
            probe.identityProof = proof
            if (detail) probe.error = `${probe.error ? probe.error + "; " : ""}${detail}`
        } catch (e) {
            probe.identityProof = "failed"
            probe.error = `${probe.error ? probe.error + "; " : ""}identity proof: ${(e as Error).message}`
        }
    }
    return probe
}

function readJson(file: string): any {
    return JSON.parse(fs.readFileSync(file, "utf8"))
}

async function main(): Promise<number> {
    let args: CliArgs
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(`${(e as Error).message}\n${usage()}`)
        return 2
    }
    if (!args.genesis && args.rpc.length === 0) {
        console.error(`give --genesis or --rpc\n${usage()}`)
        return 2
    }
    if (args.snapshot && !args.genesis) {
        console.error(`--snapshot needs --genesis\n${usage()}`)
        return 2
    }

    let shardSize = args.shardSize
    // identity -> URL to probe; "" identity means "learn it from /info"
    const targets = new Map<string, string>()
    let launch: string[] = []
    let genesis: any = null
    let blockZero: BlockZeroValidators | null = null
    if (args.genesis) {
        genesis = readJson(args.genesis)
        shardSize ??= Number(genesis?.properties?.shardSize)
        try {
            blockZero = await readBlockZeroValidators(genesis, args.snapshot)
        } catch (e) {
            console.error(`snapshot: ${(e as Error).message}`)
            return 2
        }
        for (const v of activeAtBlockZero(blockZero.rows)) {
            const id = norm(String(v.address))
            targets.set(id, typeof v.connection_url === "string" ? v.connection_url : "")
        }
        launch = launchIdentities(blockZero.rows)
    }
    if (args.peerlist) {
        for (const [id, url] of Object.entries(readJson(args.peerlist) as Record<string, string>)) {
            if (!args.genesis || targets.has(norm(id))) targets.set(norm(id), url)
        }
        if (!args.genesis) launch = [...targets.keys()]
    }
    if (!Number.isInteger(shardSize) || shardSize < 1) {
        console.error("shardSize unknown: give --genesis with properties.shardSize or --shard-size")
        return 2
    }
    const operatorsRaw = args.operators ? readJson(args.operators) : null
    if (operatorsRaw !== null && (typeof operatorsRaw !== "object" || Array.isArray(operatorsRaw))) {
        console.error("--operators must be a JSON object mapping identity to { operator, provider }")
        return 2
    }
    const operators = operatorsRaw as Record<string, unknown> | null

    const prover = await startIdentityProver(args.timeoutMs)
    let probes: ValidatorProbe[]
    try {
        const jobs: Promise<ValidatorProbe>[] = []
        for (const [id, url] of targets) {
            jobs.push(
                url
                    ? probeValidator(id, url, args.timeoutMs, prover)
                    : Promise.resolve({ identity: id, url: "", reachable: false, error: "no URL" }),
            )
        }
        for (const url of args.rpc) jobs.push(probeValidator("", url, args.timeoutMs, prover))
        probes = await Promise.all(jobs)
    } finally {
        await prover.stop()
    }
    // An --rpc probe answers for whichever identity it proves; per identity
    // the best probe wins: proven, then reachable
    const rank = (p: ValidatorProbe) => (p.identityProof === "verified" ? 2 : p.reachable ? 1 : 0)
    const merged = new Map<string, ValidatorProbe>()
    for (const p of probes) {
        const id = norm(p.identity)
        const prev = merged.get(id)
        if (!prev || rank(p) > rank(prev)) merged.set(id, p)
    }
    if (!args.genesis && !args.peerlist) {
        launch = [...merged.keys()]
    }

    const decision = checkLaunch({
        shardSize,
        genesis,
        blockZero,
        launchValidators: launch,
        probes: [...merged.values()],
        operators,
        expectedGenesisHash: args.genesisHash,
        expectedCommit: args.commit,
    })

    if (args.json) {
        console.log(JSON.stringify({ ...decision, probes: [...merged.values()] }, null, 2))
    } else {
        const short = (s: string | null, n = 12) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : "-")
        console.log(`launch validators: ${decision.launchCount}, shardSize ${shardSize}, quorum ${decision.quorum}`)
        console.log(`genesis hash: ${decision.genesisHash ?? "-"}`)
        console.log(`first committee: ${decision.committee ? decision.committee.length : "unknown"}`)
        for (const v of decision.validators) {
            const p = merged.get(v.identity)
            console.log(
                `  ${short(v.identity, 14)}  ${v.status.padEnd(17)} ` +
                    `${v.inCommittee === null ? "" : v.inCommittee ? "committee " : "reserve   "}head=${v.head ?? "-"} ` +
                    `genesis=${short(p?.genesisHash ?? null)} commit=${short(v.commit, 10)} ` +
                    `operator=${v.operator ?? "-"} provider=${v.provider ?? "-"} ${v.url ?? ""}` +
                    (p?.error ? `  (${p.error})` : ""),
            )
        }
        console.log(`operators: ${JSON.stringify(decision.operatorCounts)} providers: ${JSON.stringify(decision.providerCounts)} cap ${decision.groupCap}`)
        for (const w of decision.warnings) console.log(`warning: ${w}`)
        if (decision.go) {
            console.log(
                `GO: ${decision.countedInCommittee.length} of the ${decision.committee.length} first-committee members ` +
                    `online with proven identities on one genesis (need ${decision.quorum})`,
            )
        } else {
            console.log("NO-GO:")
            for (const r of decision.reasons) console.log(`  - ${r}`)
        }
    }
    return decision.go ? 0 : 1
}

if (import.meta.main) {
    main().then(
        code => process.exit(code),
        e => {
            console.error(e)
            process.exit(2)
        },
    )
}
