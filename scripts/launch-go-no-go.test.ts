import { describe, expect, it } from "bun:test"
import { PINNED_SHARD_IDENTITIES } from "src/utilities/constants"
import {
    type GoNoGoInput,
    MAINNET_FORKS,
    type ValidatorProbe,
    checkLaunch,
    decideGoNoGo,
} from "./launch-go-no-go"

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
        identityProof: "verified",
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
        expect(d.reasons.join("\n")).toContain("6 of the 10 members of the first committee are online")
        expect(d.validators.filter(v => v.status === "unreachable")).toHaveLength(4)
    })

    describe("with more launch validators than shardSize", () => {
        // 13 validators, shardSize 10: q is still 7, of the 10 in the first committee
        const launch = launchSet(13)
        const committee = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => launch[(i * 4) % 13])
        const reserve = launch.filter(v => !committee.includes(v))
        const operators = Object.fromEntries(
            launch.map((v, i) => [v, { operator: `op-${i % 5}`, provider: `cloud-${i % 5}` }]),
        )
        const only = (up: string[]) => launch.map(v => (up.includes(v) ? online(v) : online(v, { reachable: false })))

        it("takes q from shardSize and is GO with 7 committee members online", () => {
            const d = decideGoNoGo({ shardSize: 10, launchValidators: launch, probes: only(committee.slice(0, 7)), operators, committee })
            expect(d.quorum).toBe(7)
            expect(d.countedInCommittee).toHaveLength(7)
            expect(d.go).toBe(true)
        })

        it("is NO-GO with 7 online when only 4 of them are in the committee", () => {
            const up = [...committee.slice(0, 4), ...reserve]
            expect(up).toHaveLength(7)
            const d = decideGoNoGo({ shardSize: 10, launchValidators: launch, probes: only(up), operators, committee })
            expect(d.counted).toHaveLength(7)
            expect(d.countedInCommittee).toHaveLength(4)
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("4 of the 10 members of the first committee are online")
            expect(d.validators.filter(v => v.inCommittee === false)).toHaveLength(3)
        })

        it("refuses to decide without the committee", () => {
            const d = decideGoNoGo({ shardSize: 10, launchValidators: launch, probes: only(launch), operators })
            expect(d.go).toBe(false)
            expect(d.committee).toBeNull()
            expect(d.reasons.join("\n")).toContain("the first committee is unknown")
        })
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
        const probes = launch.map((v, i) =>
            i < 4 ? online(v, { reportedIdentity: id(50 + i), identityProof: "invalid" }) : online(v),
        )
        const d = decideGoNoGo(input({ probes }))
        expect(d.validators.filter(v => v.status === "wrong-identity")).toHaveLength(4)
        expect(d.go).toBe(false)
    })

    it("never counts an identity /info claims without a signed nonce", () => {
        // An endpoint impersonating offline validators: /info names them,
        // genesis and head look right, but nothing is signed with their keys
        const launch = launchSet(10)
        for (const proof of ["invalid", "unsigned", "failed", null, undefined] as const) {
            const probes = launch.map((v, i) => (i < 4 ? online(v, { identityProof: proof }) : online(v)))
            const d = decideGoNoGo(input({ probes }))
            expect(d.counted).toHaveLength(6)
            expect(d.validators.filter(v => v.status === "unproven-identity")).toHaveLength(4)
            expect(d.go).toBe(false)
        }
    })

    it("leaves unproven validators out of the genesis vote", () => {
        const launch = launchSet(10)
        const probes = launch.map((v, i) =>
            i < 6 ? online(v, { genesisHash: "genesis-b", identityProof: "invalid" }) : online(v),
        )
        expect(decideGoNoGo(input({ probes })).genesisHash).toBe(GENESIS)
    })

    it("compares genesis hashes without case or 0x", () => {
        const launch = launchSet(10)
        const hash = "ab".repeat(32)
        const probes = launch.map(v => online(v, { genesisHash: hash.toUpperCase() }))
        const d = decideGoNoGo(input({ probes, expectedGenesisHash: "0x" + hash }))
        expect(d.genesisHash).toBe(hash)
        expect(d.go).toBe(true)
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

    it("allows exactly shardSize - q seats per operator and provider", () => {
        // 10 validators, q 7: three may drop and seven still sign
        const launch = launchSet(10)
        const operators = Object.fromEntries(
            launch.map((v, i) => [v, { operator: `op-${i % 4}`, provider: `cloud-${i % 4}` }]),
        )
        const d = decideGoNoGo(input({ operators }))
        expect(d.groupCap).toBe(3)
        expect(Math.max(...Object.values(d.operatorCounts))).toBe(3)
        expect(d.go).toBe(true)
    })

    it("caps 9 validators at 2 per group, since losing 3 leaves 6 of the 7 needed", () => {
        const launch = launchSet(9)
        const operators = Object.fromEntries(
            launch.map((v, i) => [v, { operator: `op-${i % 3}`, provider: `cloud-${i % 3}` }]),
        )
        for (const shardSize of [9, 10]) {
            const d = decideGoNoGo({ shardSize, launchValidators: launch, probes: launch.map(v => online(v)), operators })
            expect(d.quorum).toBe(7)
            expect(d.groupCap).toBe(2)
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("operator op-0 runs 3 of 9")
        }
    })

    it("caps 12 and 13 validators at the committee's spare seats, not a third of the set", () => {
        // floor(13 / 3) = 4 seats of one operator in a committee of 10 leave 6 signers, below q = 7
        for (const n of [12, 13]) {
            const launch = launchSet(n)
            const operators = Object.fromEntries(
                launch.map((v, i) => [v, { operator: i < 4 ? "big-op" : `op-${i}`, provider: `cloud-${i % 5}` }]),
            )
            const d = decideGoNoGo({ shardSize: 10, launchValidators: launch, probes: launch.map(v => online(v)), operators, committee: launch.slice(0, 10) })
            expect(d.groupCap).toBe(3)
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain(`operator big-op runs 4 of ${n}`)
        }
    })

    it("compares operator and provider names without case or surrounding spaces", () => {
        const launch = launchSet(10)
        const operators = spread(launch)
        const spellings = ["AWS", "aws", " Aws ", "aws"]
        launch.slice(0, 4).forEach((v, i) => (operators[v] = { operator: `solo-${i}`, provider: spellings[i] }))
        const d = decideGoNoGo(input({ operators }))
        expect(d.go).toBe(false)
        expect(d.providerCounts.aws).toBe(4)
        expect(d.reasons.join("\n")).toContain("provider aws runs 4 of 10")

        const ops = spread(launch)
        launch.slice(0, 4).forEach((v, i) => (ops[v] = { operator: ["Acme", "acme ", "ACME", "acme"][i], provider: `c-${i}` }))
        expect(decideGoNoGo(input({ operators: ops })).reasons.join("\n")).toContain("operator acme runs 4 of 10")
    })

    it("is NO-GO when a launch validator holds a pinned committee identity", () => {
        const pinned = PINNED_SHARD_IDENTITIES[1]
        const launch = [...launchSet(9), pinned.toUpperCase().replace(/^0X/, "0x")]
        const d = decideGoNoGo({
            shardSize: 10,
            launchValidators: launch,
            probes: launch.map(v => online(v)),
            operators: spread(launch),
        })
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain(`pinned committee identity: ${pinned}`)
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

    it("is NO-GO on an operator entry without a non-empty operator and provider", () => {
        const launch = launchSet(10)
        const bad: Array<unknown> = [
            { operator: "op-x" },
            { provider: "cloud-x" },
            { operator: "", provider: "cloud-x" },
            { operator: "op-x", provider: "   " },
            { operator: 7, provider: "cloud-x" },
            "op-x",
            null,
        ]
        for (const entry of bad) {
            const operators: Record<string, unknown> = spread(launch)
            operators[launch[2]] = entry
            const d = decideGoNoGo(input({ operators }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain(`1 launch validators have an incomplete entry`)
            expect(d.reasons.join("\n")).toContain(launch[2])
        }
    })

    it("does not let incomplete entries hide an operator above the cap", () => {
        // Four validators of one operator, two of them with no provider:
        // the incomplete pair must not drop out of the operator count unseen
        const launch = launchSet(10)
        const operators: Record<string, unknown> = spread(launch)
        for (const v of launch.slice(0, 2)) operators[v] = { operator: "big-op", provider: `cloud-${v.slice(-1)}` }
        for (const v of launch.slice(2, 4)) operators[v] = { operator: "big-op" }
        const d = decideGoNoGo(input({ operators }))
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("2 launch validators have an incomplete entry")
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

const mainnetForks = () => Object.fromEntries(MAINNET_FORKS.map(name => [name, { activationHeight: 0 }]))

function genesisFile(rows: Array<{ address: string; status: string; valid_at: number | null }>, forks: Record<string, unknown> = mainnetForks()) {
    return { properties: { id: 1, shardSize: 10 }, forks, validators: rows }
}

describe("checkLaunch", () => {
    const launch = launchSet(10)
    const rows: Array<{ address: string; status: string; valid_at: number | null }> = launch.map(address => ({ address, status: "2", valid_at: 0 }))
    const base = {
        shardSize: 10,
        probes: launch.map(v => online(v)),
        operators: spread(launch),
        expectedGenesisHash: GENESIS,
    }
    const blockZero = (r: typeof rows) => ({ rows: r, source: "genesis" as const, reasons: [], warnings: [] })

    it("is GO on a mainnet genesis with every launch validator online", () => {
        const d = checkLaunch({ ...base, genesis: genesisFile(rows), blockZero: blockZero(rows) })
        expect(d.reasons).toEqual([])
        expect(d.go).toBe(true)
        expect(d.committee).toHaveLength(10)
    })

    it("leaves validators not staked at block 0 out of the launch set and the caps", () => {
        // A fourth validator of big-op that is not active at block 0 must not
        // count toward its cap, nor toward the launch count
        const extra = [
            { address: id(20), status: "1", valid_at: 0 },
            { address: id(21), status: "2", valid_at: 5 },
            { address: id(22), status: "2", valid_at: null },
        ]
        const operators = {
            ...spread(launch),
            ...Object.fromEntries([20, 21, 22].map(i => [id(i), { operator: "op-0", provider: "cloud-0" }])),
        }
        const all = [...rows, ...extra]
        const d = checkLaunch({ ...base, operators, genesis: genesisFile(all), blockZero: blockZero(all) })
        expect(d.launchCount).toBe(10)
        expect(d.validators.map(v => v.identity)).not.toContain(id(20))
        expect(d.validators.map(v => v.identity)).not.toContain(id(21))
        expect(d.validators.map(v => v.identity)).not.toContain(id(22))
        expect(d.operatorCounts["op-0"]).toBe(3)
        expect(d.go).toBe(true)
    })

    for (const fork of MAINNET_FORKS) {
        it(`is NO-GO when ${fork} is not scheduled at block 0`, () => {
            for (const forks of [
                Object.fromEntries(Object.entries(mainnetForks()).filter(([name]) => name !== fork)),
                { ...mainnetForks(), [fork]: { activationHeight: 1 } },
                { ...mainnetForks(), [fork]: { activationHeight: null } },
            ]) {
                const d = checkLaunch({ ...base, genesis: genesisFile(rows, forks), blockZero: blockZero(rows) })
                expect(d.go).toBe(false)
                expect(d.reasons.join("\n")).toContain(`fork ${fork} is not scheduled at activationHeight 0`)
            }
        })
    }

    it("is NO-GO without a genesis file, whose forks and validators it cannot check", () => {
        const d = checkLaunch({ ...base, genesis: null, blockZero: null, launchValidators: launch })
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("no genesis file")
    })

    it("carries the validator set's reasons and warnings into the decision", () => {
        const d = checkLaunch({
            ...base,
            genesis: genesisFile(rows),
            blockZero: { rows, source: "genesis", reasons: ["set reason"], warnings: ["set warning"] },
        })
        expect(d.go).toBe(false)
        expect(d.reasons).toContain("set reason")
        expect(d.warnings).toContain("set warning")
    })
})
