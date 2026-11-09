/**
 * Print the values a network publishes for its genesis, and check them the
 * way a node will at its first boot.
 *
 *   bun scripts/genesis-hash.ts --genesis mainnet/genesis.json [--snapshot DIR] [--json]
 *
 * --snapshot defaults to DEMOS_SNAPSHOT_DIR when that is set, as the node's
 * own snapshot lookup does (so it works unchanged inside the node container).
 *
 * --allow-unforgeable lists a genesis with fewer validators than the quorum
 * of its shardSize under `warnings` instead of `problems`. It is for test
 * harnesses whose nodes boot but never forge; a launch genesis never uses it.
 *
 * Prints:
 *   - genesisBlockHash: the hash of block 0 a node builds from this file and
 *     serves at /genesisBlock: the --genesis-hash of launch-go-no-go.ts and
 *     validator-prove-signing.ts, and the value validators set as
 *     EXPECTED_GENESIS_BLOCK_HASH. It also depends on how the file orders
 *     its keys, which the data hash leaves out. null when the genesis has no
 *     fixed timestamp, since block 0 would then take each host's clock;
 *   - genesisDataHash: the value validators set as EXPECTED_GENESIS_HASH, and
 *     the one each node reports through getGenesisDataHash;
 *   - forkScheduleDigest: what each node reports in getNetworkInfo once it has
 *     loaded this genesis;
 *   - snapshotManifestSha256: the value genesis must carry as
 *     snapshot.manifestSha256 when the network starts from that snapshot.
 *
 * Exit codes: 0 when a node with this pin would accept the files, 1 when it
 * would refuse them or could never forge a block on them (the problems are
 * listed), 2 on bad input.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { freshGenesisProblems, genesisTimestampProblem } from "src/libs/blockchain/genesis/genesisPin"
import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"
import { buildGenesisBlock } from "src/libs/blockchain/genesis/buildGenesisBlock"
import { genesisBalancesProblems } from "src/libs/blockchain/genesis/mergeGenesisBalances"
import { genesisForkProblems } from "src/libs/blockchain/genesis/applyForksAtGenesis"
import { type ForkStateEntry, verifySnapshot } from "src/libs/blockchain/genesis/verifySnapshot"
import { readGenesisSudoPubkey } from "src/libs/consensus/genesisSudoPubkey"
import { readGenesisShardSize } from "src/libs/consensus/genesisShardSize"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"
import { forkScheduleDigest } from "src/libs/peer/routines/forkScheduleAgreement"
import { loadForkConfigFromGenesis } from "src/forks"
import { getSharedState } from "src/utilities/sharedState"

export const USAGE =
    "usage: bun scripts/genesis-hash.ts --genesis FILE [--snapshot DIR] [--json] [--allow-unforgeable]"

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env) {
    const args = {
        genesis: null as string | null,
        snapshot: null as string | null,
        json: false,
        allowUnforgeable: false,
        help: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const value = () => {
            const v = argv[++i]
            if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`)
            return v
        }
        switch (argv[i]) {
            case "--genesis": args.genesis = value(); break
            case "--snapshot": args.snapshot = value(); break
            case "--json": args.json = true; break
            case "--allow-unforgeable": args.allowUnforgeable = true; break
            case "-h":
            case "--help": args.help = true; return args
            default: throw new Error(`unknown argument ${argv[i]}`)
        }
    }
    if (!args.genesis) throw new Error("--genesis is required")
    // The directory a node started with this environment reads its snapshot from
    if (args.snapshot === null && env.DEMOS_SNAPSHOT_DIR) args.snapshot = env.DEMOS_SNAPSHOT_DIR
    return args
}

export interface GenesisValues {
    genesisDataHash: string
    /** null when block 0 cannot be built; the reason is in problems. */
    genesisBlockHash: string | null
    forkScheduleDigest: string
    chainId: unknown
    snapshotManifestSha256: string | null
    /** What a node pinned to genesisDataHash would refuse at its first boot. */
    problems: string[]
}

/** sha256 of the raw manifest.json bytes, the value genesis binds as snapshot.manifestSha256. */
export function snapshotManifestSha256(snapshotDir: string): string | null {
    const manifestFile = path.join(snapshotDir, "manifest.json")
    return fs.existsSync(manifestFile)
        ? createHash("sha256").update(fs.readFileSync(manifestFile)).digest("hex")
        : null
}

/**
 * The fork_state rows the snapshot's manifest carries ([] for a manifest
 * without them), or null when the directory has no manifest. It does not
 * verify the snapshot; callers that do not verify it otherwise use
 * verifiedSnapshot.
 */
export function snapshotManifestForkState(snapshotDir: string): ForkStateEntry[] | null {
    const manifestFile = path.join(snapshotDir, "manifest.json")
    if (!fs.existsSync(manifestFile)) return null
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    return Array.isArray(manifest?.fork_state) ? manifest.fork_state : []
}

/**
 * The snapshot as the node checks it at boot (verifySnapshot): its
 * fork_state rows when it passes, else the reason the node would refuse it.
 */
export async function verifiedSnapshot(
    snapshotDir: string,
): Promise<{ forkState: ForkStateEntry[] | null; problems: string[] }> {
    try {
        const manifest = await verifySnapshot(path.resolve(snapshotDir))
        return { forkState: manifest.fork_state ?? [], problems: [] }
    } catch (e) {
        return {
            forkState: null,
            problems: [`a node would refuse the snapshot at boot: ${(e as Error).message}`],
        }
    }
}

/**
 * Rows of the snapshot's validators.jsonl, or null when the manifest lists
 * none: a node seeds its validator set from that file when the snapshot
 * carries it, and from genesis `validators` otherwise.
 */
export function snapshotValidatorRows(snapshotDir: string): number | null {
    const manifestFile = path.join(snapshotDir, "manifest.json")
    if (!fs.existsSync(manifestFile)) return null
    let rows: unknown
    try {
        rows = JSON.parse(fs.readFileSync(manifestFile, "utf8"))?.files?.["validators.jsonl"]?.rows
    } catch {
        // An unreadable manifest is reported by the snapshot verification
        return null
    }
    return Number.isInteger(rows) ? (rows as number) : null
}

const URL_PORT = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:(\d+)(?:[/?#]|$)/i

/** Why a validator's connection_url is unusable, or null. null itself is allowed, as the seed allows it. */
export function connectionUrlProblem(url: unknown): string | null {
    if (url === null) return null
    if (typeof url !== "string" || url === "") return "must be null or a non-empty string"
    const port = URL_PORT.exec(url)?.[1]
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
        return `port ${port} is outside 1-65535`
    }
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return "is not a valid URL"
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "is not an http or https URL"
    if (parsed.hostname === "") return "has no host"
    return null
}

/**
 * What a pinned hash does not catch about the network a genesis starts: a
 * shardSize the node refuses at boot, fewer validators than the quorum (the
 * node boots and never forges block 1) and validator URLs no peer can dial.
 * node-doctor --production makes the same checks on the mounted file.
 *
 * `unforgeable` holds the quorum finding alone: a node accepts such a genesis,
 * so a harness that only boots nodes (and never forges) may accept it on
 * purpose with --allow-unforgeable. Everything a node refuses is a problem.
 *
 * @param snapshotRows validators.jsonl rows of the snapshot, when it has one
 */
export function genesisNetworkFindings(
    genesis: unknown,
    snapshotRows: number | null = null,
): { problems: string[]; unforgeable: string[] } {
    const problems: string[] = []
    const unforgeable: string[] = []
    let shardSize: number | null = null
    try {
        shardSize = readGenesisShardSize(genesis)
    } catch (e) {
        problems.push(`${(e as Error).message}: a node refuses this genesis at boot`)
    }
    const raw = genesis && typeof genesis === "object" ? (genesis as { validators?: unknown }).validators : undefined
    const validators = Array.isArray(raw) ? raw : []
    if (shardSize !== null) {
        const quorum = quorumThreshold(shardSize)
        const [count, source] =
            snapshotRows !== null
                ? [snapshotRows, "the snapshot's validators.jsonl"]
                : [validators.length, "genesis validators"]
        if (count < quorum) {
            unforgeable.push(
                `${count} validators in ${source}, below the quorum of ${quorum} (2/3 + 1 of shardSize ${shardSize}): ` +
                    "a node boots on this genesis but no block after block 0 can be forged",
            )
        }
    }
    validators.forEach((v, i) => {
        if (!v || typeof v !== "object") return
        const entry = v as { address?: unknown; connection_url?: unknown }
        const problem = connectionUrlProblem(entry.connection_url === undefined ? "" : entry.connection_url)
        if (problem) {
            problems.push(
                `validators[${i}] (${String(entry.address)}) connection_url ${JSON.stringify(entry.connection_url)} ${problem}`,
            )
        }
    })
    return { problems, unforgeable }
}

/** All network findings as problems: what a launch genesis must not have. */
export function genesisNetworkProblems(genesis: unknown, snapshotRows: number | null = null): string[] {
    const { problems, unforgeable } = genesisNetworkFindings(genesis, snapshotRows)
    return [...problems, ...unforgeable]
}

/** The file as the node reads data/genesis.json: a JSON string holding JSON is parsed again. */
export function readGenesisFile(file: string): any {
    let genesis = JSON.parse(fs.readFileSync(file, "utf8"))
    if (typeof genesis === "string") genesis = JSON.parse(genesis)
    return genesis
}

/**
 * The published values for a parsed genesis, computed with the node's own
 * code. Loads the genesis fork schedule into shared state, as a booting
 * node does before it builds block 0.
 */
/**
 * @param snapshotForkState the snapshot manifest's fork_state rows; with
 *   them, problems also hold what block 0's fork pre-apply would refuse
 */
export function genesisValues(
    genesis: unknown,
    manifestSha256: string | null = null,
    snapshotForkState: ForkStateEntry[] | null = null,
): GenesisValues {
    const problems: string[] = []
    try {
        loadForkConfigFromGenesis(genesis)
    } catch (e) {
        problems.push((e as Error).message)
    }
    const genesisDataHash = hashGenesisData(genesis)
    let genesisBlockHash: string | null = null
    try {
        genesisBlockHash = buildGenesisBlock(genesis).genesisBlock.hash
    } catch (e) {
        problems.push(`block 0 could not be built: ${(e as Error).message}`)
    }
    try {
        problems.push(
            ...freshGenesisProblems({
                genesisData: genesis,
                pin: genesisDataHash,
                restore: false,
                snapshotManifestHash: manifestSha256,
            }),
        )
    } catch (e) {
        problems.push((e as Error).message)
    }
    // Both are read only after block 0 is written, so a bad value would
    // otherwise surface first on the launch validators
    try {
        readGenesisSudoPubkey(genesis)
    } catch (e) {
        problems.push((e as Error).message)
    }
    const balances = genesis && typeof genesis === "object" ? (genesis as { balances?: unknown }).balances : undefined
    problems.push(...genesisBalancesProblems(balances))
    if (snapshotForkState !== null) {
        const forks = genesis && typeof genesis === "object" ? (genesis as { forks?: unknown }).forks : undefined
        problems.push(...genesisForkProblems(forks, snapshotForkState))
    }
    // Without a fixed timestamp block 0 takes the clock of whoever builds it,
    // so the hash above is this run's and no node will match it
    if (genesisTimestampProblem(genesis) !== null) genesisBlockHash = null
    return {
        genesisDataHash,
        genesisBlockHash,
        forkScheduleDigest: forkScheduleDigest(
            getSharedState.forkConfig as unknown as Parameters<typeof forkScheduleDigest>[0],
            getSharedState.chainId,
        ),
        chainId: getSharedState.chainId,
        snapshotManifestSha256: manifestSha256,
        problems,
    }
}

async function main(): Promise<number> {
    let args: ReturnType<typeof parseArgs>
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(`${(e as Error).message}\n${USAGE}`)
        return 2
    }
    if (args.help) {
        console.log(USAGE)
        console.log("  --snapshot defaults to DEMOS_SNAPSHOT_DIR when it is set")
        console.log("  --allow-unforgeable reports fewer validators than the quorum as a warning, not a")
        console.log("    problem; for test harnesses that boot nodes without forging, never for a launch")
        return 0
    }

    const genesis = readGenesisFile(args.genesis)
    const manifestSha256 = args.snapshot ? snapshotManifestSha256(args.snapshot) : null
    if (args.snapshot && manifestSha256 === null) {
        console.error(`no manifest.json in ${args.snapshot}`)
        return 2
    }

    const snapshot = args.snapshot ? await verifiedSnapshot(args.snapshot) : null
    const result = genesisValues(genesis, manifestSha256, snapshot?.forkState ?? null)
    result.problems.push(...(snapshot?.problems ?? []))
    const network = genesisNetworkFindings(genesis, args.snapshot ? snapshotValidatorRows(args.snapshot) : null)
    result.problems.push(...network.problems)
    const warnings: string[] = []
    if (args.allowUnforgeable) warnings.push(...network.unforgeable)
    else result.problems.push(...network.unforgeable)
    if (args.json) {
        console.log(JSON.stringify({ ...result, warnings }, null, 2))
    } else {
        const blockHash = result.genesisBlockHash ?? "(cannot be known before launch; see the problems below)"
        console.log(`genesis block hash: ${blockHash}`)
        console.log("  block 0's hash, what /genesisBlock serves; pass it as --genesis-hash to")
        console.log("  launch-go-no-go.ts and validator-prove-signing.ts")
        console.log(`genesis data hash:  ${result.genesisDataHash}`)
        console.log("  what getGenesisDataHash reports; not a --genesis-hash value")
        console.log(`EXPECTED_GENESIS_BLOCK_HASH=${result.genesisBlockHash ?? ""}`)
        console.log(`EXPECTED_GENESIS_HASH=${result.genesisDataHash}`)
        console.log(`fork schedule digest: ${result.forkScheduleDigest} (chain id ${result.chainId})`)
        console.log(`snapshot manifest sha256: ${result.snapshotManifestSha256 ?? "(no snapshot given)"}`)
        if (args.snapshot) console.log(`snapshot directory: ${args.snapshot}`)
        for (const w of warnings) console.log(`warning: ${w}`)
        for (const p of result.problems) console.log(`problem: ${p}`)
    }
    return result.problems.length === 0 ? 0 : 1
}

if (import.meta.main) {
    main()
        .then(code => process.exit(code))
        .catch(e => {
            console.error((e as Error).stack ?? String(e))
            process.exit(2)
        })
}
