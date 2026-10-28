import { describe, expect, it } from "bun:test"
import { type GoNoGoInput, type ValidatorProbe, decideGoNoGo } from "./launch-go-no-go"

const id = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")
const GENESIS = "genesis-a"

function launchSet(n: number): string[] {
    return Array.from({ length: n }, (_, i) => id(i))
}

function online(identity: string, overrides: Partial<ValidatorProbe> = {}): ValidatorProbe {
    return {
        identity,
        url: `http://${identity.slice(-4)}:53550`,
        reachable: true,
        reportedIdentity: identity,
        genesisHash: GENESIS,
        head: 0,
        commit: "abc123",
        ...overrides,
    }
}

/** Ten launch validators spread over operators/providers three or fewer each. */
function spread(ids: string[]) {
    return Object.fromEntries(
        ids.map((v, i) => [v, { operator: `op-${i % 4}`, provider: `cloud-${i % 4}` }]),
    )
}

function input(overrides: Partial<GoNoGoInput> = {}): GoNoGoInput {
    const launch = launchSet(10)
    return {
        shardSize: 10,
        launchValidators: launch,
        probes: launch.map(v => online(v)),
        operators: spread(launch),
        ...overrides,
    }
}

describe("decideGoNoGo", () => {
    it("is GO with every launch validator online on one genesis", () => {
        const d = decideGoNoGo(input())
        expect(d.reasons).toEqual([])
        expect(d.go).toBe(true)
        expect(d.quorum).toBe(7)
        expect(d.counted).toHaveLength(10)
        expect(d.genesisHash).toBe(GENESIS)
    })

    it("is GO at exactly the quorum and NO-GO one below it", () => {
        const launch = launchSet(10)
        const atQuorum = launch.map((v, i) => (i < 7 ? online(v) : online(v, { reachable: false })))
        expect(decideGoNoGo(input({ probes: atQuorum })).go).toBe(true)

        const below = launch.map((v, i) => (i < 6 ? online(v) : online(v, { reachable: false })))
        const d = decideGoNoGo(input({ probes: below }))
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("6 of 10 launch validators are online")
        expect(d.validators.filter(v => v.status === "unreachable")).toHaveLength(4)
    })

    it("takes q from shardSize, not from the number of launch validators", () => {
        // 13 validators, shardSize 10: still 7
        const launch = launchSet(13)
        const probes = launch.map((v, i) => (i < 7 ? online(v) : online(v, { reachable: false })))
        const operators = Object.fromEntries(
            launch.map((v, i) => [v, { operator: `op-${i % 5}`, provider: `cloud-${i % 5}` }]),
        )
        const d = decideGoNoGo({ shardSize: 10, launchValidators: launch, probes, operators })
        expect(d.quorum).toBe(7)
        expect(d.go).toBe(true)
    })

    it("does not count validators on another genesis", () => {
        const launch = launchSet(10)
        const probes = launch.map((v, i) => (i < 4 ? online(v, { genesisHash: "genesis-b" }) : online(v)))
        const d = decideGoNoGo(input({ probes }))
        expect(d.genesisHash).toBe(GENESIS)
        expect(d.counted).toHaveLength(6)
        expect(d.go).toBe(false)
        expect(d.warnings.join("\n")).toContain("2 different genesis hashes")
        expect(d.validators.filter(v => v.status === "other-genesis")).toHaveLength(4)
    })

    it("counts only the expected genesis hash when one is given", () => {
        const launch = launchSet(10)
        const probes = launch.map((v, i) => (i < 8 ? online(v, { genesisHash: "genesis-b" }) : online(v)))
        const d = decideGoNoGo(input({ probes, expectedGenesisHash: GENESIS }))
        expect(d.counted).toHaveLength(2)
        expect(d.go).toBe(false)
    })

    it("has no genesis to count on an even split without an expected hash", () => {
        const launch = launchSet(10)
        const probes = launch.map((v, i) => online(v, { genesisHash: i < 5 ? "genesis-a" : "genesis-b" }))
        const d = decideGoNoGo(input({ probes }))
        expect(d.genesisHash).toBeNull()
        expect(d.counted).toHaveLength(0)
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("split evenly")
    })

    it("does not count an endpoint answering with another identity", () => {
        const launch = launchSet(10)
        const probes = launch.map((v, i) => (i < 4 ? online(v, { reportedIdentity: id(50 + i) }) : online(v)))
        const d = decideGoNoGo(input({ probes }))
        expect(d.validators.filter(v => v.status === "wrong-identity")).toHaveLength(4)
        expect(d.go).toBe(false)
    })

    it("matches identities case-insensitively", () => {
        const launch = launchSet(10)
        const probes = launch.map(v => online(v.toUpperCase().replace("0X", "0x"), { reportedIdentity: v.toUpperCase() }))
        expect(decideGoNoGo(input({ probes })).go).toBe(true)
    })

    it("does not count a validator on another commit when the commit is fixed", () => {
        const launch = launchSet(10)
        const probes = launch.map((v, i) => (i < 4 ? online(v, { commit: "old" }) : online(v)))
        const d = decideGoNoGo(input({ probes, expectedCommit: "abc123" }))
        expect(d.counted).toHaveLength(6)
        expect(d.go).toBe(false)
        expect(d.validators.filter(v => v.status === "other-commit")).toHaveLength(4)
    })

    it("warns about mixed commits when none is fixed", () => {
        const launch = launchSet(10)
        const probes = launch.map((v, i) => (i < 2 ? online(v, { commit: "old" }) : online(v)))
        const d = decideGoNoGo(input({ probes }))
        expect(d.go).toBe(true)
        expect(d.warnings.join("\n")).toContain("2 different commits")
    })

    it("is NO-GO when an operator runs more than a third of the launch set", () => {
        const launch = launchSet(10)
        const operators = spread(launch)
        for (const v of launch.slice(0, 4)) operators[v] = { operator: "big-op", provider: `cloud-${v.slice(-1)}` }
        const d = decideGoNoGo(input({ operators }))
        expect(d.groupCap).toBe(3)
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("operator big-op runs 4 of 10")
    })

    it("is NO-GO when a cloud provider holds more than a third", () => {
        const launch = launchSet(10)
        const operators = Object.fromEntries(
            launch.map((v, i) => [v, { operator: `op-${i}`, provider: i < 4 ? "cloud-x" : `cloud-${i}` }]),
        )
        const d = decideGoNoGo(input({ operators }))
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("provider cloud-x runs 4 of 10")
    })

    it("allows exactly a third", () => {
        const launch = launchSet(9)
        const operators = Object.fromEntries(
            launch.map((v, i) => [v, { operator: `op-${i % 3}`, provider: `cloud-${i % 3}` }]),
        )
        const d = decideGoNoGo({
            shardSize: 9,
            launchValidators: launch,
            probes: launch.map(v => online(v)),
            operators,
        })
        expect(d.groupCap).toBe(3)
        expect(d.go).toBe(true)
    })

    it("applies the cap to the launch set even when the big operator is offline", () => {
        const launch = launchSet(10)
        const operators = spread(launch)
        for (const v of launch.slice(6)) operators[v] = { operator: "big-op", provider: `cloud-${v.slice(-1)}` }
        const probes = launch.map((v, i) => (i < 7 ? online(v) : online(v, { reachable: false })))
        const d = decideGoNoGo(input({ probes, operators }))
        expect(d.counted).toHaveLength(7)
        expect(d.go).toBe(false)
    })

    it("is NO-GO without an operator map or with an unmapped validator", () => {
        expect(decideGoNoGo(input({ operators: null })).reasons.join("\n")).toContain("no operator/provider map")
        const launch = launchSet(10)
        const operators = spread(launch)
        delete operators[launch[3]]
        const d = decideGoNoGo(input({ operators }))
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("1 launch validators have no operator/provider entry")
    })

    it("marks a launch validator nobody probed", () => {
        const launch = launchSet(10)
        const d = decideGoNoGo(input({ probes: launch.slice(1).map(v => online(v)) }))
        expect(d.validators.find(v => v.identity === launch[0]).status).toBe("not-probed")
        expect(d.go).toBe(true)
    })

    it("never goes with fewer launch validators than the quorum", () => {
        const launch = launchSet(4)
        const d = decideGoNoGo({
            shardSize: 10,
            launchValidators: launch,
            probes: launch.map(v => online(v)),
            operators: Object.fromEntries(launch.map((v, i) => [v, { operator: `op-${i}`, provider: `c-${i}` }])),
        })
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("need 7")
    })
})
