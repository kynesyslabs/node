/**
 * Boot checks of the fork schedule a node runs with
 * (genesisScheduleProblems, defaultTreasuryWarning in
 * src/libs/blockchain/genesis/genesisPin.ts): a missing genesis file, a missing
 * `forks` field or an undeclared fork must not fall back to the build's
 * defaults on a pinned node or a mainnet chain id; and devModeProblem, which
 * refuses PROD=false on a mainnet chain id.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { DEFAULT_FORK_CONFIG } from "src/forks/forkConfig"
import {
    defaultTreasuryWarning,
    devModeProblem,
    genesisScheduleProblems,
} from "src/libs/blockchain/genesis/genesisPin"

const PIN = "ab".repeat(32)
const TREASURY = `0x${"7".repeat(64)}`

function testnetGenesis(): Record<string, any> {
    return JSON.parse(readFileSync("data/genesis.json", "utf8"))
}

/** A mainnet-shaped genesis that declares every fork this build knows. */
function mainnetGenesis(): Record<string, any> {
    const forks: Record<string, any> = {}
    for (const name of Object.keys(DEFAULT_FORK_CONFIG)) {
        forks[name] = { activationHeight: null }
    }
    forks.gasFeeSeparation = { activationHeight: null, treasuryAddress: TREASURY }
    return { ...testnetGenesis(), properties: { id: 4242, shardSize: 10 }, forks }
}

describe("genesisScheduleProblems", () => {
    it("leaves an unpinned test network to the defaults", () => {
        const { forks: _f, ...noForks } = testnetGenesis()
        expect(genesisScheduleProblems({ fileGenesisData: null, pin: "", blockPin: "" })).toEqual([])
        expect(
            genesisScheduleProblems({ fileGenesisData: noForks, pin: "", blockPin: "" }),
        ).toEqual([])
        expect(
            genesisScheduleProblems({
                fileGenesisData: null,
                storedGenesisData: testnetGenesis(),
                pin: "",
                blockPin: "",
            }),
        ).toEqual([])
    })

    it("refuses a restart without a genesis file when a pin is set", () => {
        for (const pins of [{ pin: PIN, blockPin: "" }, { pin: "", blockPin: PIN }]) {
            const problems = genesisScheduleProblems({
                fileGenesisData: null,
                storedGenesisData: testnetGenesis(),
                ...pins,
            })
            expect(problems.join()).toContain("no genesis file")
        }
    })

    it("refuses a restart without a genesis file when block 0 has a mainnet chain id", () => {
        const problems = genesisScheduleProblems({
            fileGenesisData: null,
            storedGenesisData: mainnetGenesis(),
            pin: "",
            blockPin: "",
        })
        expect(problems.join()).toContain("chain id is not a test network's")
    })

    it("refuses a pinned genesis without a fork schedule", () => {
        const { forks: _f, ...noForks } = testnetGenesis()
        expect(
            genesisScheduleProblems({ fileGenesisData: noForks, pin: PIN, blockPin: "" }).join(),
        ).toContain("declares no fork schedule")
        // A pinned test network may leave single forks to the defaults
        expect(
            genesisScheduleProblems({ fileGenesisData: testnetGenesis(), pin: PIN, blockPin: "" }),
        ).toEqual([])
    })

    it("refuses a mainnet genesis that leaves any fork undeclared, naming the treasury", () => {
        const g = mainnetGenesis()
        delete g.forks.gasFeeSeparation
        g.forks.atomicWork = {}
        const problem = genesisScheduleProblems({ fileGenesisData: g, pin: PIN, blockPin: "" }).join()
        expect(problem).toContain("does not declare gasFeeSeparation, atomicWork")
        expect(problem).toContain("built-in address")

        const { forks: _f, ...noForks } = mainnetGenesis()
        expect(
            genesisScheduleProblems({ fileGenesisData: noForks, pin: "", blockPin: "" }).join(),
        ).toContain("declares no fork schedule")
    })

    it("passes a mainnet genesis that declares every fork", () => {
        expect(
            genesisScheduleProblems({ fileGenesisData: mainnetGenesis(), pin: PIN, blockPin: "" }),
        ).toEqual([])
        expect(
            genesisScheduleProblems({
                fileGenesisData: mainnetGenesis(),
                storedGenesisData: mainnetGenesis(),
                pin: PIN,
                blockPin: PIN,
            }),
        ).toEqual([])
    })
})

describe("defaultTreasuryWarning", () => {
    it("warns when gasFeeSeparation falls back to the built-in treasury", () => {
        const g = testnetGenesis()
        delete g.forks.gasFeeSeparation
        expect(defaultTreasuryWarning(g)).toContain(
            DEFAULT_FORK_CONFIG.gasFeeSeparation.treasuryAddress,
        )
        expect(defaultTreasuryWarning({})).not.toBeNull()
        expect(defaultTreasuryWarning(null)).not.toBeNull()
    })

    it("is quiet when the genesis names its own", () => {
        expect(defaultTreasuryWarning(testnetGenesis())).toBeNull()
        expect(defaultTreasuryWarning(mainnetGenesis())).toBeNull()
    })
})

describe("devModeProblem", () => {
    it("refuses PROD=false on a mainnet chain id", () => {
        expect(devModeProblem(false, 4242)).toContain("set PROD=true")
    })

    it("allows PROD=true anywhere and PROD=false on the testnet, the devnet or an id-less genesis", () => {
        expect(devModeProblem(true, 4242)).toBeNull()
        for (const id of [1, 1337, undefined]) {
            expect(devModeProblem(false, id)).toBeNull()
        }
    })
})
