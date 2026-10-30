/**
 * Print the values a network publishes for its genesis, and check them the
 * way a node will at its first boot.
 *
 *   bun scripts/genesis-hash.ts --genesis mainnet/genesis.json [--snapshot DIR] [--json]
 *
 * Prints:
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
import { freshGenesisProblems } from "src/libs/blockchain/genesis/genesisPin"
import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"
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

function main(): number {
    let args: ReturnType<typeof parseArgs>
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(`${(e as Error).message}\nusage: bun scripts/genesis-hash.ts --genesis FILE [--snapshot DIR] [--json]`)
        return 2
    }

    let genesis = JSON.parse(fs.readFileSync(args.genesis, "utf8"))
    if (typeof genesis === "string") genesis = JSON.parse(genesis)

    const manifestFile = args.snapshot ? path.join(args.snapshot, "manifest.json") : null
    const snapshotManifestSha256 =
        manifestFile && fs.existsSync(manifestFile)
            ? createHash("sha256").update(fs.readFileSync(manifestFile)).digest("hex")
            : null
    if (args.snapshot && snapshotManifestSha256 === null) {
        console.error(`no manifest.json in ${args.snapshot}`)
        return 2
    }

    const problems: string[] = []
    try {
        loadForkConfigFromGenesis(genesis)
    } catch (e) {
        problems.push((e as Error).message)
    }
    const genesisDataHash = hashGenesisData(genesis)
    try {
        problems.push(
            ...freshGenesisProblems({
                genesisData: genesis,
                pin: genesisDataHash,
                restore: false,
                snapshotManifestHash: snapshotManifestSha256,
            }),
        )
    } catch (e) {
        problems.push((e as Error).message)
    }
    const result = {
        genesisDataHash,
        forkScheduleDigest: forkScheduleDigest(
            getSharedState.forkConfig as unknown as Parameters<typeof forkScheduleDigest>[0],
            getSharedState.chainId,
        ),
        chainId: getSharedState.chainId,
        snapshotManifestSha256,
        problems,
    }

    if (args.json) {
        console.log(JSON.stringify(result, null, 2))
    } else {
        console.log(`EXPECTED_GENESIS_HASH=${result.genesisDataHash}`)
        console.log(`fork schedule digest: ${result.forkScheduleDigest} (chain id ${result.chainId})`)
        console.log(`snapshot manifest sha256: ${result.snapshotManifestSha256 ?? "(no snapshot given)"}`)
        for (const p of problems) console.log(`problem: ${p}`)
    }
    return problems.length === 0 ? 0 : 1
}

if (import.meta.main) {
    process.exit(main())
}
