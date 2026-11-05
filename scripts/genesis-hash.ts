/**
 * Print the values a network publishes for its genesis, and check them the
 * way a node will at its first boot.
 *
 *   bun scripts/genesis-hash.ts --genesis mainnet/genesis.json [--snapshot DIR] [--json]
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
 * would refuse them (the problems are listed), 2 on bad input.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { freshGenesisProblems, genesisTimestampProblem } from "src/libs/blockchain/genesis/genesisPin"
import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"
import { buildGenesisBlock } from "src/libs/blockchain/genesis/buildGenesisBlock"
import { genesisBalancesProblems } from "src/libs/blockchain/genesis/mergeGenesisBalances"
import { readGenesisSudoPubkey } from "src/libs/consensus/genesisSudoPubkey"
import { forkScheduleDigest } from "src/libs/peer/routines/forkScheduleAgreement"
import { loadForkConfigFromGenesis } from "src/forks"
import { getSharedState } from "src/utilities/sharedState"

function parseArgs(argv: string[]) {
    const args = { genesis: null as string | null, snapshot: null as string | null, json: false }
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
            default: throw new Error(`unknown argument ${argv[i]}`)
        }
    }
    if (!args.genesis) throw new Error("--genesis is required")
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
export function genesisValues(genesis: unknown, manifestSha256: string | null = null): GenesisValues {
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

function main(): number {
    let args: ReturnType<typeof parseArgs>
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(`${(e as Error).message}\nusage: bun scripts/genesis-hash.ts --genesis FILE [--snapshot DIR] [--json]`)
        return 2
    }

    const genesis = readGenesisFile(args.genesis)
    const manifestSha256 = args.snapshot ? snapshotManifestSha256(args.snapshot) : null
    if (args.snapshot && manifestSha256 === null) {
        console.error(`no manifest.json in ${args.snapshot}`)
        return 2
    }

    const result = genesisValues(genesis, manifestSha256)
    if (args.json) {
        console.log(JSON.stringify(result, null, 2))
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
        for (const p of result.problems) console.log(`problem: ${p}`)
    }
    return result.problems.length === 0 ? 0 : 1
}

if (import.meta.main) {
    process.exit(main())
}
