/**
 * Launch go/no-go check.
 *
 * Probes every launch validator and decides GO only when at least q of
 * them (q = 2/3 + 1 of shardSize, the block quorum) are online on one
 * genesis hash, and no operator or cloud provider holds more than a third
 * of the launch validators. See docs/runbooks/launch-go-no-go.md.
 *
 *   bun scripts/launch-go-no-go.ts --genesis data/genesis.json \
 *       --operators operators.json [--peerlist demos_peerlist.json] \
 *       [--rpc URL[,URL...]] [--genesis-hash HASH] [--commit SHA] [--json]
 *
 * operators.json maps each validator identity to { operator, provider }.
 * Exit codes: 0 GO, 1 NO-GO, 2 bad input.
 */

import * as fs from "fs"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"

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
    error?: string | null
}

export interface GoNoGoInput {
    shardSize: number
    launchValidators: string[]
    probes: ValidatorProbe[]
    operators: Record<string, OperatorEntry> | null
    expectedGenesisHash?: string | null
    expectedCommit?: string | null
}

export type ValidatorStatus =
    | "counted"
    | "unreachable"
    | "wrong-identity"
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
    }>
    operatorCounts: Record<string, number>
    providerCounts: Record<string, number>
    /** Most validators any single operator or provider may hold. */
    groupCap: number
}

const norm = (id: string) => id.trim().toLowerCase()

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
    for (const [id, entry] of Object.entries(input.operators ?? {})) {
        operators.set(norm(id), entry)
    }
    const probeOf = new Map<string, ValidatorProbe>()
    for (const probe of input.probes) {
        probeOf.set(norm(probe.identity), probe)
    }

    // Answers from the right identity, grouped by the genesis they report
    const online = launch.filter(id => {
        const p = probeOf.get(id)
        return (
            p?.reachable === true &&
            typeof p.reportedIdentity === "string" &&
            norm(p.reportedIdentity) === id &&
            typeof p.genesisHash === "string" &&
            p.genesisHash.length > 0
        )
    })
    const byGenesis = countBy(online, id => probeOf.get(id).genesisHash)
    let genesisHash: string | null = input.expectedGenesisHash ?? null
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
        if (typeof p.reportedIdentity !== "string" || norm(p.reportedIdentity) !== id) {
            return "wrong-identity"
        }
        if (typeof p.genesisHash !== "string" || p.genesisHash.length === 0) return "no-genesis"
        if (genesisHash === null || p.genesisHash !== genesisHash) return "other-genesis"
        if (input.expectedCommit && p.commit !== input.expectedCommit) return "other-commit"
        return "counted"
    }

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
        }
    })
    const counted = validators.filter(v => v.status === "counted").map(v => v.identity)

    if (launch.length === 0) {
        reasons.push("no launch validators")
    }
    if (counted.length < quorum) {
        reasons.push(
            `${counted.length} of ${launch.length} launch validators are online on genesis ` +
                `${genesisHash ?? "(none agreed)"}${input.expectedCommit ? ` at commit ${input.expectedCommit}` : ""}; ` +
                `need ${quorum} (2/3 + 1 of shardSize ${input.shardSize})`,
        )
    }

    const commits = new Set(
        validators.filter(v => v.status === "counted" && v.commit).map(v => v.commit),
    )
    if (!input.expectedCommit && commits.size > 1) {
        warnings.push(`counted validators run ${commits.size} different commits: ${[...commits].join(", ")}`)
    }

    // A third of the launch set: one operator or provider above it can stop
    // the chain on its own when shardSize equals the validator count
    const groupCap = Math.floor(launch.length / 3)
    const unmapped = launch.filter(id => !operators.has(id))
    if (input.operators === null) {
        reasons.push("no operator/provider map given; the operator cap cannot be checked")
    } else if (unmapped.length > 0) {
        reasons.push(`${unmapped.length} launch validators have no operator/provider entry: ${unmapped.join(", ")}`)
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
                    `${kind} ${name} runs ${n} of ${launch.length} launch validators; the cap is ${groupCap} (a third)`,
                )
            }
        }
    }

    return {
        go: reasons.length === 0,
        quorum,
        launchCount: launch.length,
        genesisHash,
        counted,
        reasons,
        warnings,
        validators,
        operatorCounts,
        providerCounts,
        groupCap,
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliArgs {
    genesis: string | null
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
        "  --genesis FILE       genesis JSON: launch validators, their URLs and shardSize",
        "  --peerlist FILE      identity -> URL map (demos_peerlist.json) overriding genesis URLs",
        "  --rpc URL[,URL...]   probe these URLs; without --genesis they define the launch set",
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

export async function probeValidator(
    identity: string,
    url: string,
    timeoutMs: number,
): Promise<ValidatorProbe> {
    const base = url.replace(/\/+$/, "")
    const probe: ValidatorProbe = { identity, url: base, reachable: false }
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

    let shardSize = args.shardSize
    // identity -> URL to probe; "" identity means "learn it from /info"
    const targets = new Map<string, string>()
    let launch: string[] = []
    if (args.genesis) {
        const genesis = readJson(args.genesis)
        shardSize ??= Number(genesis?.properties?.shardSize)
        for (const v of genesis?.validators ?? []) {
            const id = norm(String(v.address))
            launch.push(id)
            targets.set(id, v.connection_url ?? "")
        }
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
    const operators = args.operators ? (readJson(args.operators) as Record<string, OperatorEntry>) : null

    const jobs: Promise<ValidatorProbe>[] = []
    for (const [id, url] of targets) {
        jobs.push(
            url
                ? probeValidator(id, url, args.timeoutMs)
                : Promise.resolve({ identity: id, url: "", reachable: false, error: "no URL" }),
        )
    }
    for (const url of args.rpc) jobs.push(probeValidator("", url, args.timeoutMs))
    const probes = await Promise.all(jobs)
    // An --rpc probe answers for whichever identity it reports; it replaces
    // a failed probe of the same identity from the genesis URL
    const merged = new Map<string, ValidatorProbe>()
    for (const p of probes) {
        const id = norm(p.identity)
        const prev = merged.get(id)
        if (!prev || (!prev.reachable && p.reachable)) merged.set(id, p)
    }
    if (!args.genesis && !args.peerlist) {
        launch = [...merged.keys()]
    }

    const decision = decideGoNoGo({
        shardSize,
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
        for (const v of decision.validators) {
            const p = merged.get(v.identity)
            console.log(
                `  ${short(v.identity, 14)}  ${v.status.padEnd(14)} head=${v.head ?? "-"} ` +
                    `genesis=${short(p?.genesisHash ?? null)} commit=${short(v.commit, 10)} ` +
                    `operator=${v.operator ?? "-"} provider=${v.provider ?? "-"} ${v.url ?? ""}` +
                    (p?.error ? `  (${p.error})` : ""),
            )
        }
        console.log(`operators: ${JSON.stringify(decision.operatorCounts)} providers: ${JSON.stringify(decision.providerCounts)} cap ${decision.groupCap}`)
        for (const w of decision.warnings) console.log(`warning: ${w}`)
        if (decision.go) {
            console.log(`GO: ${decision.counted.length} of ${decision.launchCount} online on one genesis (need ${decision.quorum})`)
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
