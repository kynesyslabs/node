/**
 * The fork schedule check a node runs on its genesis file at boot
 * (genesisScheduleProblems), read with the node's own settings:
 * DEMOS_GENESIS_FILE (default data/genesis.json), EXPECTED_GENESIS_HASH and
 * EXPECTED_GENESIS_BLOCK_HASH. node-doctor --production runs it, inside the
 * node image on a Docker host, so a genesis the node would refuse is reported
 * before the running node is stopped for the upgrade.
 *
 *   bun scripts/genesis-schedule-check.ts [--genesis FILE]
 *
 * Prints one `problem: <reason>` line per refusal, worded as the node logs
 * it after "Refusing to boot:". Exit codes: 0 when the node would accept the
 * schedule, 1 when it would refuse it, 2 on bad input.
 */

import * as fs from "node:fs"
import { genesisFileExists, genesisFilePath } from "src/libs/blockchain/genesis/genesisFile"
import { genesisScheduleProblems, parseGenesisPin } from "src/libs/blockchain/genesis/genesisPin"

export const USAGE = "usage: bun scripts/genesis-schedule-check.ts [--genesis FILE]"

/**
 * What the node's boot check refuses in the genesis file this environment
 * names, with this environment's pins. A file or pin the node cannot read is
 * a refusal too: the node does not start on it either.
 */
export function bootScheduleProblems(env: Record<string, string | undefined> = process.env): string[] {
    const previous = process.env.DEMOS_GENESIS_FILE
    if (env.DEMOS_GENESIS_FILE === undefined) delete process.env.DEMOS_GENESIS_FILE
    else process.env.DEMOS_GENESIS_FILE = env.DEMOS_GENESIS_FILE
    try {
        const pin = parseGenesisPin(env.EXPECTED_GENESIS_HASH)
        const blockPin = parseGenesisPin(env.EXPECTED_GENESIS_BLOCK_HASH, "EXPECTED_GENESIS_BLOCK_HASH")
        let fileGenesisData: unknown = null
        if (genesisFileExists()) {
            fileGenesisData = JSON.parse(fs.readFileSync(genesisFilePath(), "utf8"))
            if (typeof fileGenesisData === "string") fileGenesisData = JSON.parse(fileGenesisData)
        }
        return genesisScheduleProblems({ fileGenesisData, pin, blockPin })
    } catch (e) {
        return [(e as Error).message]
    } finally {
        if (previous === undefined) delete process.env.DEMOS_GENESIS_FILE
        else process.env.DEMOS_GENESIS_FILE = previous
    }
}

function main(argv: string[]): number {
    const env: Record<string, string | undefined> = { ...process.env }
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--genesis": {
                const v = argv[++i]
                if (v === undefined) {
                    console.error(`--genesis needs a value\n${USAGE}`)
                    return 2
                }
                env.DEMOS_GENESIS_FILE = v
                break
            }
            case "-h":
            case "--help":
                console.log(USAGE)
                return 0
            default:
                console.error(`unknown argument ${argv[i]}\n${USAGE}`)
                return 2
        }
    }
    const problems = bootScheduleProblems(env)
    for (const p of problems) console.log(`problem: ${p}`)
    return problems.length === 0 ? 0 : 1
}

if (import.meta.main) {
    process.exit(main(process.argv.slice(2)))
}
