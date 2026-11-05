/**
 * Height-1 check: after launch, the chain the validators run is the
 * published genesis.
 *
 * For every node it asks: block 0 is the agreed hash, the chain has moved
 * past block 0, block 1 builds on that block 0, and the validator set and
 * balances the node stores are the ones the genesis file and snapshot seed
 * (block 0's staked set as the node takes it, see launch-validator-set.ts;
 * every genesis.balances entry; the largest snapshot balances, or all of
 * them). Nodes must also agree on block 1.
 *
 * The node answers state questions for its tip only, so the state part is
 * compared only while every block after block 0 is empty. Once a block
 * carries a transaction, a different balance is no longer evidence of a
 * wrong genesis, and that part is reported as skipped instead.
 * See docs/mainnet/genesis-hash.md.
 *
 *   bun scripts/launch-height1-check.ts --genesis mainnet/genesis.json \
 *       --snapshot mainnet/snapshot --genesis-hash BLOCK0_HASH \
 *       [--rpc URL[,URL...]] [--balances N|all] [--max-scan N] [--json]
 *
 * Without --rpc the nodes are block 0's validators at their connection_url.
 * Exit codes: 0 PASS, 1 FAIL, 2 bad input, 3 inconclusive (no node could
 * have its state compared: run it again right after block 1, before any
 * transaction is sent).
 */

import * as path from "path"
import { normHash } from "./launch-go-no-go"
import { activeAtBlockZero, readBlockZeroValidators, type ValidatorRow } from "./launch-validator-set"

export interface ExpectedValidator {
    address: string
    status: string
    /** null when the row carries no parsable stake; the node stores it as given. */
    stakedAmount: bigint | null
    validAt: number
    /** Who seeds the row: osDenomination scales snapshot rows and genesis rows at different moments. */
    source: "snapshot" | "genesis"
}

export interface ExpectedBalance {
    address: string
    /** As written in the snapshot or genesis.balances, before any osDenomination migration. */
    raw: bigint
    source: "snapshot" | "genesis"
}

/**
 * What decides whether the osDenomination migration (balances and stakes
 * x 10^9) has run by a given height, mirroring chainGenesis.ts,
 * applyForksAtGenesis.ts and the block hook in chainBlocks.ts.
 */
export interface DenominationInputs {
    /** A snapshot manifest was present, so block 0 took the snapshot path. */
    snapshotPath: boolean
    /** genesis.forks.osDenomination is present: on the snapshot path it runs (or is marked) at block 0. */
    osEntryPresent: boolean
    /** The effective activation height after loading the genesis (code default when absent). */
    osEffectiveHeight: number | null
    /** The snapshot manifest records osDenomination as applied: its values are already scaled. */
    snapshotOsApplied: boolean
}

export interface LaunchExpectation {
    /** The agreed block 0 hash, normalised. */
    genesisHash: string
    validators: ExpectedValidator[]
    balances: ExpectedBalance[]
    denomination: DenominationInputs
}

export interface ObservedBlock {
    number: number
    hash: string | null
    previousHash: string | null
    txCount: number | null
}

export interface ObservedValidator {
    address: string
    status: unknown
    stakedAmount: unknown
    validAt: unknown
}

export interface NodeObservation {
    url: string
    reachable: boolean
    error?: string | null
    genesisHash?: string | null
    /** The tip after the state was read, so a block landing meanwhile is seen. */
    head?: number | null
    /** Blocks 1..min(head, maxScan) as the node serves them. */
    blocks?: ObservedBlock[] | null
    /** getValidators at block 0; undefined when not read. */
    validators?: ObservedValidator[] | null
    /** address -> balance as answered (null when the read failed); undefined when not read. */
    balances?: Record<string, unknown> | null
}

export type CheckStatus = "pass" | "fail" | "skip"

export interface Check {
    /** The node URL, or "*" for a check across nodes or of the inputs. */
    node: string
    name: string
    status: CheckStatus
    detail: string
}

export interface Height1Decision {
    verdict: "pass" | "fail" | "inconclusive"
    checks: Check[]
}

const OS_PER_DEM = 1_000_000_000n
const SHOWN = 5

const norm = (id: string) => id.trim().toLowerCase()

/** A reply value as an exact integer: bigints may arrive as "123", "123n" or a safe number. */
export function parseAmount(value: unknown): bigint | null {
    if (typeof value === "bigint") return value
    if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null
    if (typeof value === "string") {
        const s = value.trim().replace(/n$/, "")
        return /^-?\d+$/.test(s) ? BigInt(s) : null
    }
    return null
}

/**
 * The factors that turn raw genesis values into what the node stores at a
 * height. On the snapshot path the migration runs inside block 0 when the
 * genesis lists osDenomination (unless the snapshot is already migrated),
 * before genesis validators are seeded; otherwise the block hook runs it
 * at its effective height, over every row, unless block 0 left a marker.
 */
export function denominationScales(
    d: DenominationInputs,
    head: number,
): { balance: bigint; snapshotStake: bigint; genesisStake: bigint } {
    const atBlockZero = d.snapshotPath && d.osEntryPresent && !d.snapshotOsApplied
    const markerAtBlockZero = d.snapshotPath && d.osEntryPresent
    const byHook = !markerAtBlockZero && d.osEffectiveHeight !== null && d.osEffectiveHeight <= head
    const scaled = atBlockZero || byHook ? OS_PER_DEM : 1n
    return {
        balance: scaled,
        snapshotStake: scaled,
        genesisStake: byHook ? OS_PER_DEM : 1n,
    }
}

function differsByDenomination(expected: bigint, actual: bigint): boolean {
    return actual !== 0n && (actual === expected * OS_PER_DEM || expected === actual * OS_PER_DEM)
}

function listed(items: string[]): string {
    return items.length <= SHOWN
        ? items.join("; ")
        : `${items.slice(0, SHOWN).join("; ")}; and ${items.length - SHOWN} more`
}

/** Why the node's state can no longer be read as block 0's state, or null when it can. */
function stateNotComparable(obs: NodeObservation, maxScan: number): string | null {
    const head = obs.head ?? 0
    if (head > maxScan) {
        return `head ${head} is past the first ${maxScan} blocks, so its state is not block 0's alone`
    }
    const blocks = obs.blocks ?? []
    for (let n = 1; n <= head; n++) {
        const block = blocks.find(b => b.number === n)
        if (!block || block.txCount === null) return `block ${n} could not be read`
        if (block.txCount > 0) return `block ${n} has ${block.txCount} transactions`
    }
    return null
}

function compareValidators(
    expected: ExpectedValidator[],
    observed: ObservedValidator[],
    scales: ReturnType<typeof denominationScales>,
): string[] {
    const problems: string[] = []
    const want = new Map(expected.map(v => [norm(v.address), v]))
    const got = new Map(observed.map(v => [norm(String(v.address)), v]))
    const missing = [...want.keys()].filter(a => !got.has(a))
    const extra = [...got.keys()].filter(a => !want.has(a))
    if (missing.length > 0) problems.push(`missing from the chain: ${listed(missing)}`)
    if (extra.length > 0) problems.push(`on the chain but not in the genesis: ${listed(extra)}`)
    const differ: string[] = []
    for (const [address, v] of want) {
        const o = got.get(address)
        if (!o) continue
        if (String(o.status) !== v.status) differ.push(`${address} status ${String(o.status)}, expected ${v.status}`)
        if (Number(o.validAt) !== v.validAt) differ.push(`${address} valid_at ${String(o.validAt)}, expected ${v.validAt}`)
        if (v.stakedAmount !== null) {
            const scale = v.source === "snapshot" ? scales.snapshotStake : scales.genesisStake
            const want = v.stakedAmount * scale
            const have = parseAmount(o.stakedAmount)
            if (have === null) {
                differ.push(`${address} stake ${JSON.stringify(o.stakedAmount)} is not an integer`)
            } else if (have !== want) {
                differ.push(
                    `${address} stake ${have}, expected ${want}` +
                        (differsByDenomination(want, have) ? " (off by 10^9: osDenomination ran a different number of times)" : ""),
                )
            }
        }
    }
    if (differ.length > 0) problems.push(listed(differ))
    return problems
}

function compareBalances(
    expected: ExpectedBalance[],
    observed: Record<string, unknown>,
    scale: bigint,
): { problems: string[]; checked: number } {
    const wrong: string[] = []
    const unreadable: string[] = []
    const answers = new Map(Object.entries(observed).map(([a, v]) => [norm(a), v]))
    for (const b of expected) {
        const raw = answers.get(norm(b.address))
        const have = parseAmount(raw)
        if (have === null) {
            unreadable.push(b.address)
            continue
        }
        const want = b.raw * scale
        if (have !== want) {
            wrong.push(
                `${b.address} has ${have}, expected ${want}` +
                    (differsByDenomination(want, have) ? " (off by 10^9)" : ""),
            )
        }
    }
    const problems: string[] = []
    if (wrong.length > 0) problems.push(`${wrong.length} balances differ: ${listed(wrong)}`)
    if (unreadable.length > 0) problems.push(`${unreadable.length} balances could not be read: ${listed(unreadable)}`)
    return { problems, checked: expected.length }
}

/**
 * The check as a pure function of what the nodes answered, so it can be
 * tested without a network.
 */
export function decideHeight1(
    expected: LaunchExpectation,
    observations: NodeObservation[],
    opts: { maxScan: number } = { maxScan: 20 },
): Height1Decision {
    const checks: Check[] = []
    const add = (node: string, name: string, status: CheckStatus, detail: string) =>
        checks.push({ node, name, status, detail })
    const block0 = normHash(expected.genesisHash)
    let compared = 0

    if (observations.length === 0) add("*", "nodes", "fail", "no node to check")
    if (expected.validators.length === 0) {
        add("*", "genesis-validators", "fail", "the genesis and snapshot seed no staked validator at block 0")
    }

    const block1Hashes = new Map<string, string[]>()
    for (const obs of observations) {
        const node = obs.url
        if (!obs.reachable) {
            add(node, "reachable", "fail", obs.error ?? "no answer")
            continue
        }
        const served = obs.genesisHash ? normHash(obs.genesisHash) : null
        add(
            node,
            "block-0",
            served === block0 ? "pass" : "fail",
            served === block0 ? `block 0 is ${block0}` : `block 0 is ${served ?? "(not served)"}, the agreed one is ${block0}`,
        )
        const head = obs.head ?? null
        if (head === null || head < 1) {
            add(node, "head", "fail", `head is ${head ?? "(not served)"}; block 1 has not been produced`)
            continue
        }
        add(node, "head", "pass", `head ${head}`)

        const block1 = (obs.blocks ?? []).find(b => b.number === 1)
        if (!block1 || block1.previousHash === null) {
            add(node, "block-1-parent", "skip", "block 1 could not be read")
        } else {
            const parent = normHash(block1.previousHash)
            add(
                node,
                "block-1-parent",
                parent === block0 ? "pass" : "fail",
                parent === block0 ? "block 1 builds on block 0" : `block 1 builds on ${parent}, not on ${block0}`,
            )
            if (block1.hash) {
                const h = normHash(block1.hash)
                block1Hashes.set(h, [...(block1Hashes.get(h) ?? []), node])
            }
        }

        const notComparable = stateNotComparable(obs, opts.maxScan)
        if (notComparable !== null) {
            add(node, "validators", "skip", notComparable)
            add(node, "balances", "skip", notComparable)
            continue
        }
        const scales = denominationScales(expected.denomination, head)
        let stateCompared = true
        if (!Array.isArray(obs.validators)) {
            add(node, "validators", "fail", "getValidators at block 0 could not be read")
            stateCompared = false
        } else {
            const problems = compareValidators(expected.validators, obs.validators, scales)
            add(
                node,
                "validators",
                problems.length === 0 ? "pass" : "fail",
                problems.length === 0
                    ? `${expected.validators.length} staked validators match block 0's set`
                    : problems.join("; "),
            )
        }
        if (!obs.balances || typeof obs.balances !== "object") {
            add(node, "balances", "fail", "balances could not be read")
            stateCompared = false
        } else {
            const { problems, checked } = compareBalances(expected.balances, obs.balances, scales.balance)
            add(
                node,
                "balances",
                problems.length === 0 ? "pass" : "fail",
                problems.length === 0 ? `${checked} balances match the genesis` : problems.join("; "),
            )
        }
        if (stateCompared) compared++
    }

    if (block1Hashes.size > 1) {
        add(
            "*",
            "block-1-agreement",
            "fail",
            `nodes hold different blocks at height 1: ${[...block1Hashes]
                .map(([h, nodes]) => `${h} (${nodes.join(", ")})`)
                .join("; ")}`,
        )
    } else if (block1Hashes.size === 1) {
        add("*", "block-1-agreement", "pass", `every node that served block 1 holds ${[...block1Hashes.keys()][0]}`)
    }

    const failed = checks.some(c => c.status === "fail")
    return { verdict: failed ? "fail" : compared === 0 ? "inconclusive" : "pass", checks }
}

/**
 * The expected state from the genesis file, block 0's validator rows and
 * the balance rows to check. Balances: every genesis.balances entry, which
 * overrides the snapshot row of the same account (mergeGenesisBalances.ts),
 * plus the given snapshot rows.
 */
export function buildExpectation(input: {
    genesisHash: string
    genesis: { balances?: unknown }
    validatorRows: ValidatorRow[]
    validatorSource: "snapshot" | "genesis" | "none"
    snapshotBalances: Array<{ pubkey: string; balance: bigint }>
    denomination: DenominationInputs
}): LaunchExpectation {
    const validators: ExpectedValidator[] = activeAtBlockZero(input.validatorRows).map(row => {
        const stake = parseAmount((row as Record<string, unknown>).staked_amount)
        return {
            address: norm(String(row.address)),
            status: String(row.status),
            stakedAmount: stake,
            validAt: row.valid_at as number,
            source: input.validatorSource === "snapshot" ? "snapshot" : "genesis",
        }
    })
    const balances = new Map<string, ExpectedBalance>()
    for (const row of input.snapshotBalances) {
        balances.set(norm(row.pubkey), { address: row.pubkey, raw: row.balance, source: "snapshot" })
    }
    if (Array.isArray(input.genesis.balances)) {
        // Last entry wins on a repeated account, as the node's overlay does
        for (const entry of input.genesis.balances) {
            if (!Array.isArray(entry) || typeof entry[0] !== "string") continue
            const raw = parseAmount(entry[1])
            if (raw === null) continue
            balances.set(norm(entry[0]), { address: entry[0], raw, source: "genesis" })
        }
    }
    return {
        genesisHash: input.genesisHash,
        validators,
        balances: [...balances.values()],
        denomination: input.denomination,
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliArgs {
    genesis: string | null
    snapshot: string | null
    genesisHash: string | null
    rpc: string[]
    balances: number | "all"
    maxScan: number
    json: boolean
    timeoutMs: number
}

function usage(): string {
    return [
        "usage: bun scripts/launch-height1-check.ts --genesis FILE --snapshot DIR --genesis-hash HASH [options]",
        "  --genesis FILE       the published genesis file",
        "  --snapshot DIR       the published snapshot directory the validators booted with",
        "  --genesis-hash HASH  the agreed block 0 hash (genesis block hash from scripts/genesis-hash.ts)",
        "  --rpc URL[,URL...]   nodes to check; default: block 0's validators at their connection_url",
        "  --balances N|all     snapshot accounts to check, largest balances first (default 100);",
        "                       every genesis.balances entry is always checked",
        "  --max-scan N         compare state only while head <= N and blocks 1..head are empty (default 20)",
        "  --timeout MS         per-request timeout (default 5000)",
        "  --json               machine-readable output",
    ].join("\n")
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        genesis: null,
        snapshot: null,
        genesisHash: null,
        rpc: [],
        balances: 100,
        maxScan: 20,
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
            case "--genesis-hash": args.genesisHash = value(); break
            case "--rpc": args.rpc.push(...value().split(",").map(s => s.trim()).filter(Boolean)); break
            case "--balances": {
                const v = value()
                args.balances = v === "all" ? "all" : Number(v)
                if (args.balances !== "all" && (!Number.isInteger(args.balances) || args.balances < 0)) {
                    throw new Error("--balances must be a non-negative integer or all")
                }
                break
            }
            case "--max-scan": args.maxScan = Number(value()); break
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
    if (!args.genesis || !args.snapshot || !args.genesisHash) {
        throw new Error("--genesis, --snapshot and --genesis-hash are required")
    }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(args.genesisHash.trim())) {
        throw new Error("--genesis-hash must be 64 hex characters")
    }
    if (!Number.isInteger(args.maxScan) || args.maxScan < 1) throw new Error("--max-scan must be a positive integer")
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout must be positive")
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

async function nodeCall(base: string, message: string, data: unknown, timeoutMs: number): Promise<any> {
    const res = await fetchJson(base, timeoutMs, { method: "nodeCall", params: [{ message, data, muid: null }] })
    if (res?.result !== 200) throw new Error(`${message}: result ${res?.result} ${JSON.stringify(res?.extra ?? res?.response ?? null)}`)
    return res.response
}

async function readBlocks(base: string, from: number, to: number, timeoutMs: number): Promise<ObservedBlock[]> {
    const blocks: ObservedBlock[] = []
    for (let n = from; n <= to; n++) {
        try {
            const block = await nodeCall(base, "getBlockByNumber", { blockNumber: n }, timeoutMs)
            const content = typeof block?.content === "string" ? JSON.parse(block.content) : block?.content
            blocks.push({
                number: n,
                hash: typeof block?.hash === "string" ? block.hash : null,
                previousHash: typeof content?.previousHash === "string" ? content.previousHash : null,
                txCount: Array.isArray(content?.ordered_transactions) ? content.ordered_transactions.length : null,
            })
        } catch {
            blocks.push({ number: n, hash: null, previousHash: null, txCount: null })
        }
    }
    return blocks
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++
            out[i] = await fn(items[i])
        }
    })
    await Promise.all(workers)
    return out
}

export async function observeNode(
    url: string,
    addresses: string[],
    maxScan: number,
    timeoutMs: number,
): Promise<NodeObservation> {
    const base = url.replace(/\/+$/, "")
    const obs: NodeObservation = { url: base, reachable: false }
    try {
        const genesis = await fetchJson(`${base}/genesisBlock`, timeoutMs)
        obs.reachable = true
        obs.genesisHash = typeof genesis?.hash === "string" ? genesis.hash : null
    } catch (e) {
        obs.error = (e as Error).message
        return obs
    }
    try {
        const firstHead = Number(await nodeCall(base, "getLastBlockNumber", {}, timeoutMs))
        obs.head = firstHead
        if (!(firstHead >= 1)) return obs
        // Past the scan window only block 1 is needed, for its parent
        obs.blocks = await readBlocks(base, 1, Math.min(firstHead, maxScan), timeoutMs)
        if (stateNotComparable(obs, maxScan) !== null) return obs

        try {
            obs.validators = await nodeCall(base, "getValidators", { blockNumber: 0 }, timeoutMs)
        } catch (e) {
            obs.validators = null
            obs.error = `validators: ${(e as Error).message}`
        }
        const answers = await mapLimit(addresses, 8, async address => {
            try {
                const info = await nodeCall(base, "getAddressInfo", { address }, timeoutMs)
                return [address, info?.balance ?? null] as const
            } catch {
                return [address, null] as const
            }
        })
        obs.balances = Object.fromEntries(answers)

        // A block that landed while the state was read may have changed it
        const lastHead = Number(await nodeCall(base, "getLastBlockNumber", {}, timeoutMs))
        if (lastHead > firstHead) {
            obs.head = lastHead
            obs.blocks.push(...(await readBlocks(base, firstHead + 1, Math.min(lastHead, maxScan), timeoutMs)))
        }
    } catch (e) {
        obs.error = (e as Error).message
    }
    return obs
}

async function main(): Promise<number> {
    let args: CliArgs
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(`${(e as Error).message}\n${usage()}`)
        return 2
    }

    const { CategorizedLogger } = await import("src/utilities/tui")
    // The node's own log lines would land in the middle of the output
    CategorizedLogger.getInstance().enableTuiMode()
    const { readGenesisFile, genesisValues, snapshotManifestSha256 } = await import("./genesis-hash")
    const { getSharedState } = await import("src/utilities/sharedState")
    const { loadSnapshot } = await import("src/libs/blockchain/genesis/loadSnapshot")

    let genesis: any
    try {
        genesis = readGenesisFile(args.genesis)
    } catch (e) {
        console.error(`cannot read ${args.genesis}: ${(e as Error).message}`)
        return 2
    }
    const snapshotDir = path.resolve(args.snapshot)
    const inputChecks: Check[] = []
    const values = genesisValues(genesis, snapshotManifestSha256(snapshotDir))
    const agreed = normHash(args.genesisHash)
    if (values.genesisBlockHash === null || normHash(values.genesisBlockHash) !== agreed) {
        inputChecks.push({
            node: "*",
            name: "genesis-file",
            status: "fail",
            detail: `the genesis file builds block 0 ${values.genesisBlockHash ?? "(unknown)"}, not the agreed ${agreed}`,
        })
    }

    let blockZero: Awaited<ReturnType<typeof readBlockZeroValidators>>
    let snapshotBalances: Array<{ pubkey: string; balance: bigint }> = []
    let snapshotPath = false
    let snapshotOsApplied = false
    try {
        blockZero = await readBlockZeroValidators(genesis, snapshotDir)
        const previous = process.env.DEMOS_SNAPSHOT_DIR
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir
        try {
            const snapshot = await loadSnapshot()
            if (snapshot.available) {
                snapshotPath = true
                snapshotOsApplied =
                    snapshot.manifest.fork_state?.some(f => f.fork_name === "osDenomination" && f.applied) ?? false
                for await (const row of snapshot.streamGcrMain()) {
                    snapshotBalances.push({ pubkey: row.pubkey, balance: BigInt(row.balance) })
                }
            }
        } finally {
            if (previous === undefined) delete process.env.DEMOS_SNAPSHOT_DIR
            else process.env.DEMOS_SNAPSHOT_DIR = previous
        }
    } catch (e) {
        console.error(`cannot read the snapshot: ${(e as Error).message}`)
        return 2
    }
    for (const reason of blockZero.reasons) {
        inputChecks.push({ node: "*", name: "block-0-validators", status: "fail", detail: reason })
    }
    snapshotBalances.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1))
    if (args.balances !== "all") snapshotBalances = snapshotBalances.slice(0, args.balances)

    const expectation = buildExpectation({
        genesisHash: agreed,
        genesis,
        validatorRows: blockZero.rows,
        validatorSource: blockZero.source,
        snapshotBalances,
        denomination: {
            snapshotPath,
            osEntryPresent: Boolean(genesis?.forks?.osDenomination),
            osEffectiveHeight: getSharedState.forkConfig.osDenomination.activationHeight,
            snapshotOsApplied,
        },
    })

    const urls =
        args.rpc.length > 0
            ? args.rpc
            : activeAtBlockZero(blockZero.rows)
                  .map(r => r.connection_url)
                  .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    const addresses = expectation.balances.map(b => b.address)
    const observations: NodeObservation[] = []
    for (const url of [...new Set(urls)]) {
        observations.push(await observeNode(url, addresses, args.maxScan, args.timeoutMs))
    }

    const decision = decideHeight1(expectation, observations, { maxScan: args.maxScan })
    decision.checks.unshift(...inputChecks)
    if (inputChecks.some(c => c.status === "fail")) decision.verdict = "fail"

    if (args.json) {
        console.log(JSON.stringify({ ...decision, nodes: observations.map(o => o.url) }, null, 2))
    } else {
        for (const c of decision.checks) {
            console.log(`${c.status.toUpperCase().padEnd(4)}  ${c.node}  ${c.name}: ${c.detail}`)
        }
        console.log(`\n${decision.verdict.toUpperCase()}: ${observations.length} nodes, ${expectation.validators.length} validators, ${expectation.balances.length} balances`)
    }
    return decision.verdict === "pass" ? 0 : decision.verdict === "fail" ? 1 : 3
}

if (import.meta.main) {
    main()
        .then(code => process.exit(code))
        .catch(e => {
            console.error((e as Error).stack ?? String(e))
            process.exit(2)
        })
}
