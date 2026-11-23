/**
 * Boot checks of the fork schedule a node runs with
 * (genesisScheduleProblems, defaultTreasuryWarning in
 * src/libs/blockchain/genesis/genesisPin.ts): a missing genesis file, a missing
 * `forks` field or an undeclared fork must not fall back to the build's
 * defaults on a pinned node or a mainnet chain id; and devModeProblem, which
 * refuses PROD=false on a mainnet chain id; xffModeProblem, which refuses
 * XFF_MODE=legacy on one; and requireValidatorsProblem, which refuses one
 * without DEMOS_REQUIRE_VALIDATORS=true.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { DEFAULT_FORK_CONFIG } from "src/forks/forkConfig"
import {
    bootSettingProblems,
    chainIdOf,
    defaultTreasuryWarning,
    devModeProblem,
    genesisScheduleProblems,
    isMainnetChainId,
    pinRequirementProblem,
    requireValidatorsProblem,
    xffModeProblem,
} from "src/libs/blockchain/genesis/genesisPin"

const PIN = "ab".repeat(32)
const TREASURY = `0x${"7".repeat(64)}`

function shippedGenesis(): Record<string, any> {
    return JSON.parse(readFileSync("data/genesis.json", "utf8"))
}

/**
 * The shipped genesis with the testnet's chain id (1, which
 * NON_MAINNET_CHAIN_IDS lists as a test network), so these cases do not
 * depend on the chain id data/genesis.json carries.
 */
function testnetGenesis(): Record<string, any> {
    const g = shippedGenesis()
    g.properties = { ...g.properties, id: 1 }
    return g
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

    // data/genesis.json as shipped: its chain id (8587492) is not a test
    // network's and its forks field declares only some of the forks this build
    // knows, so the check names every other one, pinned or not, and a node
    // booting from this file is refused. Update this case with the file.
    it("reports the shipped data/genesis.json as a mainnet genesis that leaves forks undeclared", () => {
        const shipped = shippedGenesis()
        expect(chainIdOf(shipped)).toBe(8587492)
        expect(isMainnetChainId(chainIdOf(shipped))).toBe(true)
        const undeclared = Object.keys(DEFAULT_FORK_CONFIG).filter(
            name => !Object.hasOwn(shipped.forks, name),
        )
        expect(undeclared).not.toContain("gasFeeSeparation")
        const expected = [
            `the genesis does not declare ${undeclared.join(", ")}: on a mainnet chain id every ` +
                "fork this build knows needs an activationHeight (a height or null), or it takes " +
                "this build's default",
        ]
        for (const pin of ["", PIN]) {
            expect(
                genesisScheduleProblems({ fileGenesisData: shipped, pin, blockPin: "" }),
            ).toEqual(expected)
        }
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

describe("requireValidatorsProblem", () => {
    // The caller passes process.env.DEMOS_REQUIRE_VALIDATORS === "true", the value getShard reads
    const enabled = (raw: string | undefined) => raw === "true"

    it("refuses a mainnet chain id without the variable, naming it and the value to set", () => {
        const problem = requireValidatorsProblem(enabled(undefined), 4242)
        expect(problem).toContain("DEMOS_REQUIRE_VALIDATORS")
        expect(problem).toContain("set DEMOS_REQUIRE_VALIDATORS=true")
    })

    it("refuses a mainnet chain id when the variable is false or not exactly true", () => {
        for (const raw of ["false", "", "1", "TRUE"]) {
            expect(requireValidatorsProblem(enabled(raw), 4242)).not.toBeNull()
        }
    })

    it("accepts a mainnet chain id when the variable is true", () => {
        expect(requireValidatorsProblem(enabled("true"), 4242)).toBeNull()
    })

    it("leaves the testnet, the devnet and an id-less genesis unchanged", () => {
        for (const id of [1, 1337, undefined]) {
            for (const raw of [undefined, "false", "true"]) {
                expect(requireValidatorsProblem(enabled(raw), id)).toBeNull()
            }
        }
    })
})

describe("xffModeProblem", () => {
    it("refuses XFF_MODE=legacy on a mainnet chain id, naming the mode, the reason and the fix", () => {
        const problem = xffModeProblem("legacy", 4242)
        expect(problem).toContain("XFF_MODE=legacy")
        expect(problem).toContain("choose the IP")
        expect(problem).toContain("XFF_MODE=strict with TRUSTED_PROXIES")
        expect(problem).toContain("4242")
    })

    it("allows legacy on the testnet and the devnet", () => {
        expect(xffModeProblem("legacy", 1)).toBeNull()
        expect(xffModeProblem("legacy", 1337)).toBeNull()
    })

    it("allows strict, off, unset and empty on a mainnet chain id", () => {
        for (const mode of ["strict", "off", undefined, null, ""]) {
            expect(xffModeProblem(mode, 4242)).toBeNull()
        }
    })
})

describe("bootSettingProblems", () => {
    const settings = { env: {}, prod: true, xffMode: undefined, requireValidators: true }

    it("gives every refusal of a mainnet chain id in one list, in check order", () => {
        const problems = bootSettingProblems("", 4242, {
            ...settings,
            prod: false,
            xffMode: "legacy",
            requireValidators: false,
        })
        expect(problems).toEqual([
            pinRequirementProblem("", {}, 4242)!,
            devModeProblem(false, 4242)!,
            xffModeProblem("legacy", 4242)!,
            requireValidatorsProblem(false, 4242)!,
        ])
        expect(problems[0]).toContain("EXPECTED_GENESIS_HASH is not set")
        expect(problems[1]).toContain("set PROD=true")
        expect(problems[2]).toContain("XFF_MODE=legacy")
        expect(problems[3]).toContain("set DEMOS_REQUIRE_VALIDATORS=true")
    })

    it("is empty when the settings are fine or the chain id is a test network's", () => {
        expect(bootSettingProblems(PIN, 4242, settings)).toEqual([])
        expect(
            bootSettingProblems("", 1337, {
                ...settings,
                prod: false,
                xffMode: "legacy",
                requireValidators: false,
            }),
        ).toEqual([])
    })
})
