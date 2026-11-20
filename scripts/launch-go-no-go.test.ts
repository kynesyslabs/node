import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PINNED_SHARD_IDENTITIES } from "src/utilities/constants"
import { notaryKeyHex, tlsnVerifiedPayload } from "src/libs/blockchain/testSupport/tlsnVerifiedFixtures"
import { TLSN_VERIFY_WASM_SHA256 } from "src/libs/tlsnotary/wasmVerifier"
import {
    type GoNoGoInput,
    KNOWN_FORKS,
    LAUNCH_DORMANT_FORKS,
    MAINNET_FORKS,
    NON_MAINNET_CHAIN_IDS,
    REFUSED_MAINNET_CHAIN_IDS,
    type ValidatorProbe,
    checkLaunch,
    commitSha,
    committedVerifierSha256,
    tlsnNotaryReasons,
    decideGoNoGo,
    sameCommit,
    parseArgs,
    treasuryReasons,
    notaryKeysReasons,
    parseExpectedNotaryKeys,
    KNOWN_TEST_TREASURIES,
    KNOWN_TEST_NOTARY_KEYS,
    blockZeroNftReasons,
    mainnetGenesisReasons,
    nftAllowlistPinReasons,
} from "./launch-go-no-go"
import { NFT_ALLOWLIST_PATH, NFT_ALLOWLIST_SHA256 } from "src/features/staking/nftAllowlist"

const id = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")
const GENESIS = "genesis-a"
const COMMIT = "abc1234def5678abc1234def5678abc1234def56"
/** What launch day passes: the agreed block 0 hash and release commit. */
const AGREED = { expectedGenesisHash: GENESIS, expectedCommit: COMMIT }

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
        commit: COMMIT,
        identityProof: "verified",
        ...overrides,
    }
}

/** Ten launch validators spread over owners/operators/providers three or fewer each. */
function spread(ids: string[]): Record<string, { owner?: string; operator: string; provider: string }> {
    return Object.fromEntries(
        ids.map((v, i) => [v, { owner: `owner-${i % 4}`, operator: `op-${i % 4}`, provider: `cloud-${i % 4}` }]),
    )
}

function input(overrides: Partial<GoNoGoInput> = {}): GoNoGoInput {
    const launch = launchSet(10)
    return {
        shardSize: 10,
        launchValidators: launch,
        probes: launch.map(v => online(v)),
        operators: spread(launch),
        ...AGREED,
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
            const d = decideGoNoGo({ ...AGREED, shardSize: 10, launchValidators: launch, probes: only(committee.slice(0, 7)), operators, committee })
            expect(d.quorum).toBe(7)
            expect(d.countedInCommittee).toHaveLength(7)
            expect(d.go).toBe(true)
        })

        it("is NO-GO with 7 online when only 4 of them are in the committee", () => {
            const up = [...committee.slice(0, 4), ...reserve]
            expect(up).toHaveLength(7)
            const d = decideGoNoGo({ ...AGREED, shardSize: 10, launchValidators: launch, probes: only(up), operators, committee })
            expect(d.counted).toHaveLength(7)
            expect(d.countedInCommittee).toHaveLength(4)
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("4 of the 10 members of the first committee are online")
            expect(d.validators.filter(v => v.inCommittee === false)).toHaveLength(3)
        })

        it("refuses to decide without the committee", () => {
            const d = decideGoNoGo({ ...AGREED, shardSize: 10, launchValidators: launch, probes: only(launch), operators })
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
        const d = decideGoNoGo(input({ probes, expectedGenesisHash: null }))
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
        expect(decideGoNoGo(input({ probes, expectedGenesisHash: null })).genesisHash).toBe(GENESIS)
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
        const d = decideGoNoGo(input({ probes }))
        expect(d.counted).toHaveLength(6)
        expect(d.go).toBe(false)
        expect(d.validators.filter(v => v.status === "other-commit")).toHaveLength(4)
    })

    describe("the agreed genesis block and commit", () => {
        it("is NO-GO without --genesis-hash, even when every validator agrees", () => {
            const d = decideGoNoGo(input({ expectedGenesisHash: null }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("no --genesis-hash given")
            // Still shown, for diagnosis
            expect(d.genesisHash).toBe(GENESIS)
            expect(d.counted).toHaveLength(10)
        })

        it("is NO-GO when --genesis-hash is the genesis data hash", () => {
            const DATA = "d".repeat(64)
            const probes = launchSet(10).map(v => online(v, { genesisDataHash: DATA }))
            const d = decideGoNoGo(input({ probes, expectedGenesisHash: "0x" + DATA, expectedGenesisDataHash: DATA }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("is the genesis data hash; validators serve the block 0 hash")
        })

        it("is NO-GO without --commit, even when every validator runs one commit", () => {
            const d = decideGoNoGo(input({ expectedCommit: null }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("no --commit given")
        })

        it("names mixed commits as a NO-GO reason without --commit", () => {
            const launch = launchSet(10)
            const probes = launch.map((v, i) => (i < 2 ? online(v, { commit: "fedcba9" }) : online(v)))
            const d = decideGoNoGo(input({ probes, expectedCommit: null }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("2 different commits")
        })

        it("is NO-GO on one validator on another commit, even with quorum online", () => {
            const launch = launchSet(10)
            const probes = launch.map((v, i) => (i === 0 ? online(v, { commit: "fedcba98" + COMMIT.slice(8) }) : online(v)))
            const d = decideGoNoGo(input({ probes }))
            expect(d.counted).toHaveLength(9)
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain(`${launch[0]} runs commit fedcba98`)
        })

        it("is NO-GO on a dirty build of the launch commit", () => {
            const launch = launchSet(10)
            const probes = launch.map((v, i) =>
                online(v, { commit: `<v1.0.0-rc.4>${COMMIT}`, dirty: i === 2 ? true : i === 3 ? null : false }),
            )
            const d = decideGoNoGo(input({ probes }))
            expect(d.validators[2].status).toBe("other-commit")
            expect(d.validators[3].status).toBe("counted")
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain(`${launch[2]} runs a dirty build of <v1.0.0-rc.4>${COMMIT}`)
        })

        it("is NO-GO on a validator that reports no commit", () => {
            const launch = launchSet(10)
            const probes = launch.map((v, i) => (i === 0 ? online(v, { commit: null }) : online(v)))
            const d = decideGoNoGo(input({ probes }))
            expect(d.validators[0].status).toBe("other-commit")
            expect(d.go).toBe(false)
        })

        it("matches a short or full SHA against what the node reports, with any branch prefix", () => {
            for (const reported of [
                COMMIT,
                COMMIT.toUpperCase(),
                // What /info reports: <GIT_BRANCH>sha, the release tag in a release image
                `<v1.0.0-rc.4>${COMMIT}`,
                `<mainnet-20261115>${COMMIT}`,
                `<abcdef1234567>${COMMIT}`,
                `<stabilisation>${COMMIT}`,
                `<unknown>${COMMIT}`,
                `stabilisation@${COMMIT}`,
                `0x${COMMIT}`,
            ]) {
                for (const expected of [COMMIT, COMMIT.slice(0, 7), COMMIT.slice(0, 12).toUpperCase(), `main@${COMMIT.slice(0, 9)}`]) {
                    const probes = launchSet(10).map(v => online(v, { commit: reported }))
                    const d = decideGoNoGo(input({ probes, expectedCommit: expected }))
                    expect(d.reasons).toEqual([])
                    expect(d.go).toBe(true)
                }
            }
        })
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

    describe("launch genesis expectations", () => {
        const DATA = "d".repeat(64)
        const DIGEST = "e".repeat(64)
        const expected = {
            expectedGenesisDataHash: DATA,
            expectedScheduleDigest: DIGEST,
            requiredForks: MAINNET_FORKS,
        }
        const good = (v: string, o: Partial<ValidatorProbe> = {}) =>
            online(v, { genesisDataHash: DATA, scheduleDigest: DIGEST, activeForks: [...MAINNET_FORKS], ...o })

        it("is GO when every validator reports the launch genesis, schedule and forks", () => {
            const d = decideGoNoGo(input({ ...expected, probes: launchSet(10).map(v => good(v)) }))
            expect(d.reasons).toEqual([])
            expect(d.go).toBe(true)
        })

        it("is NO-GO on one validator with other genesis data, even with quorum online", () => {
            const launch = launchSet(10)
            const d = decideGoNoGo(
                input({
                    ...expected,
                    probes: launch.map((v, i) => (i === 0 ? good(v, { genesisDataHash: "f".repeat(64) }) : good(v))),
                }),
            )
            expect(d.validators[0].status).toBe("other-genesis-data")
            expect(d.counted).toHaveLength(9)
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("runs genesis data")
        })

        it("is NO-GO on one validator on another genesis block, even with quorum online", () => {
            const launch = launchSet(10)
            const d = decideGoNoGo(
                input({
                    ...expected,
                    probes: launch.map((v, i) => (i === 0 ? good(v, { genesisHash: "a".repeat(64) }) : good(v))),
                }),
            )
            expect(d.validators[0].status).toBe("other-genesis")
            expect(d.counted).toHaveLength(9)
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("runs genesis block")
        })

        it("is NO-GO on a validator with another fork schedule", () => {
            const launch = launchSet(10)
            const d = decideGoNoGo(
                input({
                    ...expected,
                    probes: launch.map((v, i) => (i === 3 ? good(v, { scheduleDigest: "0".repeat(64) }) : good(v))),
                }),
            )
            expect(d.validators[3].status).toBe("other-schedule")
            expect(d.go).toBe(false)
        })

        it("is NO-GO on a validator that does not report a mainnet fork as active", () => {
            const launch = launchSet(10)
            const d = decideGoNoGo(
                input({
                    ...expected,
                    probes: launch.map((v, i) =>
                        i === 5 ? good(v, { activeForks: MAINNET_FORKS.filter(f => f !== "commitLock") }) : good(v),
                    ),
                }),
            )
            expect(d.validators[5].status).toBe("forks-inactive")
            expect(d.reasons.join("\n")).toContain("commitLock")
            expect(d.go).toBe(false)
        })

        it("does not count an older build that reports none of them", () => {
            const d = decideGoNoGo(input({ ...expected }))
            expect(d.validators.every(v => v.status === "other-genesis-data")).toBe(true)
            expect(d.go).toBe(false)
        })
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

const TREASURY = "0x" + "ab".repeat(32)
/** The notary keys tlsnVerifiedPayload() lists, as --expected-notary-keys names them. */
const NOTARY_KEYS = `demos-notary-1:${notaryKeyHex(0x11)},demos-notary-standby:${notaryKeyHex(0x22)}`

/**
 * A mainnet fork at 0, gasFeeSeparation with the treasury and tlsnVerified
 * with the notary keys each is refused without.
 */
const atZero = (name: string, extra: Record<string, unknown> = {}) =>
    name === "gasFeeSeparation"
        ? { activationHeight: 0, treasuryAddress: TREASURY, ...extra }
        : name === "tlsnVerified"
          ? { activationHeight: 0, ...tlsnVerifiedPayload(), ...extra }
          : { activationHeight: 0, ...extra }

/** Every fork this build knows declared: the mainnet ones at 0, the rest off. */
const mainnetForks = () =>
    Object.fromEntries(KNOWN_FORKS.map(name => [name, MAINNET_FORKS.includes(name) ? atZero(name) : { activationHeight: null }]))

/** Mints of the allowlist this build ships, one per test seat. */
const MINTS: string[] = JSON.parse(fs.readFileSync(NFT_ALLOWLIST_PATH, "utf8")).mints
const NFT_OWNER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const PROOF_TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
const nftOf = (i: number) => ({ nft_mint: MINTS[i], nft_owner: NFT_OWNER, nft_proof_tx: PROOF_TX })

/** Each row seated by its own allowlisted NFT, unless it names its NFT fields itself. */
function withNfts<T extends object>(rows: T[]): T[] {
    return rows.map((row, i) => ("nft_mint" in row || "nft_exempt" in row ? row : { ...row, ...nftOf(i) }))
}

function genesisFile(rows: Array<{ address: string; status: string; valid_at: number | null }>, forks: Record<string, unknown> = mainnetForks()) {
    return { properties: { id: 7, shardSize: 10 }, forks, validators: withNfts(rows) }
}

describe("checkLaunch", () => {
    const launch = launchSet(10)
    const rows: Array<{ address: string; status: string; valid_at: number | null }> = launch.map(address => ({ address, status: "2", valid_at: 0 }))
    const base = {
        shardSize: 10,
        probes: launch.map(v => online(v)),
        operators: spread(launch),
        ...AGREED,
        expectedTreasury: TREASURY,
        expectedNotaryKeys: NOTARY_KEYS,
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

    for (const fork of LAUNCH_DORMANT_FORKS) {
        it(`is NO-GO when ${fork} is scheduled at launch`, () => {
            for (const height of [0, 1000]) {
                const forks = { ...mainnetForks(), [fork]: { activationHeight: height } }
                const d = checkLaunch({ ...base, genesis: genesisFile(rows, forks), blockZero: blockZero(rows) })
                expect(d.go).toBe(false)
                expect(d.reasons.join("\n")).toContain(`fork ${fork} is scheduled at ${height}`)
            }
        })
    }

    it("keeps networkGovernance off at launch, not among the forks switched on at block 0", () => {
        expect(LAUNCH_DORMANT_FORKS).toContain("networkGovernance")
        expect(MAINNET_FORKS).not.toContain("networkGovernance")
        expect(KNOWN_FORKS).toContain("networkGovernance")
    })

    it("keeps atomicWork off at launch, as docs/mainnet/genesis.md states", () => {
        expect(LAUNCH_DORMANT_FORKS).toContain("atomicWork")
        expect(MAINNET_FORKS).not.toContain("atomicWork")
        const forks = { ...mainnetForks(), atomicWork: { activationHeight: 1000000 } }
        const d = checkLaunch({ ...base, genesis: genesisFile(rows, forks), blockZero: blockZero(rows) })
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("fork atomicWork is scheduled at 1000000")
    })

    it("launches with seats open by NFT only: the gate, tokenStaking and nftValidatorGating at block 0", () => {
        expect(MAINNET_FORKS).toContain("tokenStakingGate")
        expect(MAINNET_FORKS).toContain("tokenStaking")
        expect(MAINNET_FORKS).toContain("nftValidatorGating")
        expect(LAUNCH_DORMANT_FORKS).not.toContain("tokenStaking")
        expect(LAUNCH_DORMANT_FORKS).not.toContain("nftValidatorGating")
    })

    it("launches with bound web2 and xm proofs and no structure-only TLSN claims", () => {
        expect(MAINNET_FORKS).toContain("web2ProofBinding")
        expect(MAINNET_FORKS).toContain("tlsnProofEnforcement")
        expect(MAINNET_FORKS).toContain("xmProofBinding")
    })

    describe("the agreed notary keys", () => {
        const OTHER_KEY = notaryKeyHex(0x33)

        it("is NO-GO on the mainnet chain id when no notary keys were agreed", () => {
            for (const expectedNotaryKeys of [null, undefined, " "]) {
                const d = checkLaunch({ ...base, expectedNotaryKeys, genesis: genesisFile(rows), blockZero: blockZero(rows) })
                expect(d.go).toBe(false)
                expect(d.reasons).toEqual([
                    "no --expected-notary-keys given: pass the agreed tlsnVerified notary keys as id:hex " +
                        "(or DEMOS_EXPECTED_NOTARY_KEYS) so the genesis notary keys can be checked against them",
                ])
            }
        })

        it("is NO-GO when the genesis lists another well-formed key", () => {
            const payload = tlsnVerifiedPayload()
            const keys = payload.notaryKeys as Array<{ id: string; alg: string; hex: string }>
            keys[1] = { ...keys[1], hex: OTHER_KEY }
            const forks = { ...mainnetForks(), tlsnVerified: { activationHeight: 0, ...payload } }
            const d = checkLaunch({ ...base, genesis: genesisFile(rows, forks), blockZero: blockZero(rows) })
            expect(d.go).toBe(false)
            expect(d.reasons).toEqual([
                `the genesis tlsnVerified notaryKeys demos-notary-1:${notaryKeyHex(0x11)}, demos-notary-standby:${OTHER_KEY} ` +
                    `are not the agreed notary keys demos-notary-1:${notaryKeyHex(0x11)}, demos-notary-standby:${notaryKeyHex(0x22)}`,
            ])
        })

        it("is NO-GO when the genesis lists fewer or more keys than were agreed, or the same key under another id", () => {
            const only = `demos-notary-1:${notaryKeyHex(0x11)}`
            const g = genesisFile(rows)
            expect(notaryKeysReasons(g, only).join("\n")).toContain("are not the agreed notary keys")
            expect(notaryKeysReasons(g, `${NOTARY_KEYS},spare:${OTHER_KEY}`).join("\n")).toContain("are not the agreed notary keys")
            const renamed = `demos-notary-1:${notaryKeyHex(0x11)},demos-notary-2:${notaryKeyHex(0x22)}`
            expect(notaryKeysReasons(g, renamed).join("\n")).toContain("are not the agreed notary keys")
            const doubled = genesisFile(rows, {
                ...mainnetForks(),
                tlsnVerified: {
                    activationHeight: 0,
                    ...tlsnVerifiedPayload(),
                    notaryKeys: [0, 1].map(() => ({ id: "demos-notary-1", alg: "k256", hex: notaryKeyHex(0x11) })),
                },
            })
            expect(notaryKeysReasons(doubled, NOTARY_KEYS).join("\n")).toContain("are not the agreed notary keys")
            const forks = { ...mainnetForks(), tlsnVerified: { activationHeight: null } }
            expect(notaryKeysReasons(genesisFile(rows, forks), NOTARY_KEYS)).toEqual([
                `the genesis tlsnVerified has no notaryKeys; the agreed notary keys are demos-notary-1:${notaryKeyHex(0x11)}, ` +
                    `demos-notary-standby:${notaryKeyHex(0x22)}`,
            ])
        })

        it("compares without regard to order, case or surrounding spaces", () => {
            const reordered = ` demos-notary-standby:${notaryKeyHex(0x22).toUpperCase()} , demos-notary-1:${notaryKeyHex(0x11)} `
            const d = checkLaunch({ ...base, expectedNotaryKeys: reordered, genesis: genesisFile(rows), blockZero: blockZero(rows) })
            expect(d.reasons).toEqual([])
            expect(d.go).toBe(true)
        })

        it("checks given keys on the testnet and devnet chain ids, and needs none there", () => {
            for (const chainId of NON_MAINNET_CHAIN_IDS) {
                const g = { ...genesisFile(rows), properties: { id: chainId, shardSize: 10 } }
                expect(notaryKeysReasons(g, null)).toEqual([])
                expect(notaryKeysReasons(g, NOTARY_KEYS)).toEqual([])
                expect(notaryKeysReasons(g, `demos-notary-1:${OTHER_KEY}`).join("\n")).toContain("are not the agreed notary keys")
            }
        })

        it("refuses an agreed key the node would refuse in a genesis", () => {
            expect(parseExpectedNotaryKeys(NOTARY_KEYS)).toEqual([
                { id: "demos-notary-1", hex: notaryKeyHex(0x11) },
                { id: "demos-notary-standby", hex: notaryKeyHex(0x22) },
            ])
            for (const [raw, why] of [
                ["", "names no key"],
                [notaryKeyHex(0x11), "entry 1 is not id:hex"],
                [`:${notaryKeyHex(0x11)}`, "entry 1 is not id:hex"],
                [`demos-notary-1:${notaryKeyHex(0x11).slice(0, 40)}`, "entry 1.hex must be a 33-byte compressed secp256k1 public key"],
                [`demos notary:${notaryKeyHex(0x11)}`, "entry 1.id must match"],
                [`a:${notaryKeyHex(0x11)},b:${notaryKeyHex(0x11)}`, "repeats hex"],
                [`a:${notaryKeyHex(0x11)},a:${notaryKeyHex(0x22)}`, "repeats id a"],
            ] as const) {
                expect(() => parseExpectedNotaryKeys(raw)).toThrow(why)
                expect(notaryKeysReasons(genesisFile(rows), raw).join("\n")).toContain(raw === "" ? "no --expected-notary-keys given" : why)
            }
        })
    })

    describe("validator concentration", () => {
        it("is NO-GO on the mainnet chain id when a launch validator names no owner", () => {
            const operators = spread(launch)
            delete (operators[launch[2]] as Record<string, string>).owner
            const d = checkLaunch({ ...base, operators, genesis: genesisFile(rows), blockZero: blockZero(rows) })
            expect(d.go).toBe(false)
            expect(d.reasons).toEqual([
                `1 launch validators have no owner in the operator map, which the mainnet chain id requires: ${launch[2]}`,
            ])
        })

        it("does not need owners on the testnet chain id", () => {
            const operators = Object.fromEntries(launch.map((v, i) => [v, { operator: `op-${i % 4}`, provider: `cloud-${i % 4}` }]))
            const genesis = { ...genesisFile(rows), properties: { id: NON_MAINNET_CHAIN_IDS[0], shardSize: 10 } }
            const d = checkLaunch({ ...base, operators, genesis, blockZero: blockZero(rows) })
            expect(d.reasons.join("\n")).not.toContain("no owner")
        })

        it("is NO-GO when one owner runs four validators through four operators", () => {
            const operators = Object.fromEntries(
                launch.map((v, i) => [v, { owner: i < 4 ? "buyer" : `owner-${i}`, operator: `op-${i}`, provider: `cloud-${i}` }]),
            )
            const d = checkLaunch({ ...base, operators, genesis: genesisFile(rows), blockZero: blockZero(rows) })
            expect(d.go).toBe(false)
            expect(d.ownerCounts.buyer).toBe(4)
            expect(d.reasons.join("\n")).toContain("owner buyer runs 4 of 10 launch validators; the cap is 3")
        })

        it("counts owners named like Object members", () => {
            for (const name of ["constructor", "__proto__", "tostring"]) {
                const operators = Object.fromEntries(
                    launch.map((v, i) => [v, { owner: i < 4 ? name : `owner-${i}`, operator: `op-${i}`, provider: `cloud-${i}` }]),
                )
                const d = checkLaunch({ ...base, operators, genesis: genesisFile(rows), blockZero: blockZero(rows) })
                expect(d.go).toBe(false)
                expect(d.reasons.join("\n")).toContain(`owner ${name} runs 4 of 10 launch validators; the cap is 3`)
            }
        })

        it("is NO-GO when one owner holds a third of block 0's stake", () => {
            const staked = rows.map((r, i) => ({ ...r, staked_amount: i === 0 ? "5000" : "1000" }))
            const d = checkLaunch({ ...base, genesis: genesisFile(staked), blockZero: blockZero(staked) })
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("owner owner-0 holds 7000 of the 14000 block 0 stake (50%), a third or more")
        })
    })

    describe("the agreed treasury", () => {
        it("is NO-GO on the mainnet chain id when no treasury was agreed", () => {
            for (const expectedTreasury of [null, undefined, " "]) {
                const d = checkLaunch({ ...base, expectedTreasury, genesis: genesisFile(rows), blockZero: blockZero(rows) })
                expect(d.go).toBe(false)
                expect(d.reasons.join("\n")).toContain("no --expected-treasury given")
            }
        })

        it("is NO-GO when the genesis names another well-formed treasury", () => {
            const other = "0x" + "cd".repeat(32)
            const forks = { ...mainnetForks(), gasFeeSeparation: { activationHeight: 0, treasuryAddress: other } }
            const d = checkLaunch({ ...base, genesis: genesisFile(rows, forks), blockZero: blockZero(rows) })
            expect(d.go).toBe(false)
            expect(d.reasons).toEqual([`the genesis gasFeeSeparation treasuryAddress ${other} is not the agreed treasury ${TREASURY}`])
        })

        it("compares the agreed treasury without regard to case or surrounding spaces", () => {
            const d = checkLaunch({
                ...base,
                expectedTreasury: ` ${TREASURY.toUpperCase().replace("0X", "0x")} `,
                genesis: genesisFile(rows),
                blockZero: blockZero(rows),
            })
            expect(d.reasons).toEqual([])
            expect(d.go).toBe(true)
        })

        it("checks a given treasury on the testnet and devnet chain ids, and needs none there", () => {
            for (const chainId of NON_MAINNET_CHAIN_IDS) {
                const g = { ...genesisFile(rows), properties: { id: chainId, shardSize: 10 } }
                expect(treasuryReasons(g, null)).toEqual([])
                expect(treasuryReasons(g, "0x" + "cd".repeat(32)).join("\n")).toContain("is not the agreed treasury")
            }
        })

        it("is NO-GO on the mainnet chain id with a test genesis treasury, even when it was the one agreed", () => {
            for (const test of KNOWN_TEST_TREASURIES) {
                const forks = { ...mainnetForks(), gasFeeSeparation: { activationHeight: 0, treasuryAddress: test } }
                const d = checkLaunch({
                    ...base,
                    expectedTreasury: test.toUpperCase().replace("0X", "0x"),
                    genesis: genesisFile(rows, forks),
                    blockZero: blockZero(rows),
                })
                expect(d.go).toBe(false)
                expect(d.reasons.join("\n")).toContain("treasury of a test genesis")
            }
        })

        it("lets a test genesis treasury through on the testnet and devnet chain ids", () => {
            const [test] = KNOWN_TEST_TREASURIES
            for (const chainId of NON_MAINNET_CHAIN_IDS) {
                const forks = { ...mainnetForks(), gasFeeSeparation: { activationHeight: 0, treasuryAddress: test } }
                const g = { ...genesisFile(rows, forks), properties: { id: chainId, shardSize: 10 } }
                expect(treasuryReasons(g, test)).toEqual([])
            }
        })

        it("knows every treasury the repository's genesis files name", () => {
            const root = path.resolve(import.meta.dir, "..")
            const found = new Set<string>()
            for (const dir of ["testing", "docs", "data"]) {
                const glob = new Bun.Glob("**/*.json")
                if (!fs.existsSync(path.join(root, dir))) continue
                for (const file of glob.scanSync({ cwd: path.join(root, dir) })) {
                    const text = fs.readFileSync(path.join(root, dir, file), "utf8")
                    for (const m of text.matchAll(/"treasuryAddress"\s*:\s*"(0x[0-9a-fA-F]{64})"/g)) {
                        found.add(m[1].toLowerCase())
                    }
                }
            }
            expect(found.size).toBeGreaterThan(0)
            for (const address of found) expect(KNOWN_TEST_TREASURIES).toContain(address)
        })

        it("is NO-GO when the genesis has no treasury to compare", () => {
            const forks = { ...mainnetForks(), gasFeeSeparation: { activationHeight: 0 } }
            expect(treasuryReasons(genesisFile(rows, forks), TREASURY).join("\n")).toContain("has no treasuryAddress")
        })
    })

    it("launches with L2PS settling, TLSNotary verified and both kill switches unscheduled", () => {
        expect(MAINNET_FORKS).toContain("l2psSettlement")
        expect(MAINNET_FORKS).not.toContain("l2psGate")
        expect(LAUNCH_DORMANT_FORKS).toContain("l2psGate")
        expect(MAINNET_FORKS).toContain("tlsnVerified")
        expect(MAINNET_FORKS).not.toContain("tlsnDisabled")
        expect(LAUNCH_DORMANT_FORKS).toContain("tlsnDisabled")
        expect(MAINNET_FORKS).toHaveLength(31)
    })

    describe("validators seated by NFT at block 0", () => {
        const reasonsFor = (validators: Array<Record<string, unknown>>) =>
            checkLaunch({ ...base, genesis: { ...genesisFile(rows), validators }, blockZero: blockZero(rows) }).reasons.join("\n")

        it("is GO when every genesis seat names an allowlisted mint, its wallet and a proof", () => {
            expect(reasonsFor(rows.map((r, i) => ({ ...r, ...nftOf(i) })))).toBe("")
        })

        it("is NO-GO on a seat without the NFT fields, with a bad field, or an unlisted mint", () => {
            const seats = rows.map((r, i) => ({ ...r, ...nftOf(i) }))
            const missing = seats.map((r, i) => (i === 3 ? { address: r.address, status: r.status, valid_at: 0 } : r))
            expect(reasonsFor(missing)).toContain(`genesis.validators[3] (${id(3)}): nft_mint must be a base58 string`)
            const badProof = seats.map((r, i) => (i === 4 ? { ...r, nft_proof_tx: "not base58!" } : r))
            expect(reasonsFor(badProof)).toContain(`genesis.validators[4] (${id(4)}): nft_proof_tx must be a base58 string`)
            const unlisted = seats.map((r, i) => (i === 5 ? { ...r, nft_mint: "1".repeat(44) } : r))
            expect(reasonsFor(unlisted)).toContain("is not on the allowlist")
        })

        it("is NO-GO when one mint backs two seats", () => {
            const seats = rows.map((r, i) => ({ ...r, ...nftOf(i === 7 ? 6 : i) }))
            expect(reasonsFor(seats)).toContain(`nft_mint ${MINTS[6]} already backs ${id(6)}`)
        })

        it("is NO-GO on an nft_exempt seat", () => {
            const seats = rows.map((r, i) => (i === 2 ? { ...r, nft_exempt: true } : { ...r, ...nftOf(i) }))
            expect(reasonsFor(seats)).toContain("1 genesis validators are nft_exempt")
        })

        it("holds seats from the snapshot's validators.jsonl to the same fields", () => {
            const snapshot = (r: Array<Record<string, unknown>>) => ({ rows: r, source: "snapshot" as const, reasons: [], warnings: [] })
            const genesis = genesisFile(rows)
            expect(blockZeroNftReasons(genesis, snapshot(withNfts(rows)))).toEqual([])
            const bare = blockZeroNftReasons(genesis, snapshot(rows))
            expect(bare).toHaveLength(10)
            expect(bare[0]).toContain(`validators.jsonl[0] (${id(0)}): nft_mint must be a base58 string`)
            const d = checkLaunch({ ...base, genesis, blockZero: snapshot(rows) })
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("validators.jsonl[9]")
            // Rows from genesis.validators are judged there, not again here
            expect(blockZeroNftReasons(genesis, blockZero(rows))).toEqual([])
            // Nothing to hold without the fork at 0
            const off = genesisFile(rows, { ...mainnetForks(), nftValidatorGating: { activationHeight: null } })
            expect(blockZeroNftReasons(off, snapshot(rows))).toEqual([])
        })

        it("checks no NFT fields when the fork is not at 0, which is NO-GO on its own", () => {
            const genesis = { ...genesisFile(rows, { ...mainnetForks(), nftValidatorGating: { activationHeight: null } }), validators: rows }
            const reasons = mainnetGenesisReasons(genesis).join("\n")
            expect(reasons).toContain("fork nftValidatorGating is not scheduled at activationHeight 0")
            expect(reasons).not.toContain("must be a base58 string")
        })
    })

    describe("the NFT allowlist pin", () => {
        it("passes for the allowlist this build ships", () => {
            expect(NFT_ALLOWLIST_SHA256).toMatch(/^[0-9a-f]{64}$/)
            expect(nftAllowlistPinReasons()).toEqual([])
        })

        it("is NO-GO without a pin, on a file that does not hash to it, and on an unreadable file", () => {
            expect(nftAllowlistPinReasons(NFT_ALLOWLIST_PATH, "")[0]).toContain("pins no NFT allowlist digest")
            expect(nftAllowlistPinReasons(NFT_ALLOWLIST_PATH, "0".repeat(64))[0]).toContain("does not load as pinned")
            expect(nftAllowlistPinReasons("/nonexistent/allowlist.json")[0]).toContain("does not load as pinned")
        })

        it("is NO-GO when the file names no digest of its own", () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nft-allowlist-"))
            try {
                const file = path.join(dir, "allowlist.json")
                fs.writeFileSync(file, JSON.stringify({ mints: MINTS }))
                expect(nftAllowlistPinReasons(file)[0]).toContain("names sha256 null")
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })

        it("is checked with the NFT seats of a mainnet genesis", () => {
            const genesis = genesisFile(rows)
            expect(mainnetGenesisReasons(genesis)).toEqual([])
        })
    })

    describe("the TLSNotary notary keys", () => {
        const withTlsn = (entry: Record<string, unknown>) =>
            genesisFile(rows, { ...mainnetForks(), tlsnVerified: { activationHeight: 0, ...entry } })
        const check = (entry: Record<string, unknown>) =>
            checkLaunch({ ...base, genesis: withTlsn(entry), blockZero: blockZero(rows) })

        it("is GO with ceremony keys and a pinned verifier", () => {
            const d = check(tlsnVerifiedPayload())
            expect(d.reasons).toEqual([])
            expect(d.go).toBe(true)
        })

        it("is NO-GO on the template's placeholder keys", () => {
            const keys = (tlsnVerifiedPayload().notaryKeys as Array<Record<string, string>>).map(k => ({
                ...k,
                hex: "FILL: notary public key from the notary key ceremony",
            }))
            const d = check(tlsnVerifiedPayload({ notaryKeys: keys }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("placeholder or unset notary keys")
        })

        it("is NO-GO without keys, or without the payload at all", () => {
            for (const entry of [tlsnVerifiedPayload({ notaryKeys: [] }), {}]) {
                const d = check(entry)
                expect(d.go).toBe(false)
                expect(d.reasons.join("\n")).toContain("placeholder or unset notary keys")
            }
        })

        it("is NO-GO on a test key from this repository", () => {
            for (const hex of KNOWN_TEST_NOTARY_KEYS) {
                const d = check(tlsnVerifiedPayload({ notaryKeys: [{ id: "n1", alg: "k256", hex }] }))
                expect(d.go).toBe(false)
                expect(d.reasons.join("\n")).toContain(`lists the test notary key ${hex}`)
            }
        })

        it("is NO-GO on a payload the node would refuse", () => {
            const d = check(tlsnVerifiedPayload({ verifierWasmSha256: "FILL: sha256" }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("payload the node refuses")
            expect(d.reasons.join("\n")).toContain("verifierWasmSha256")
        })

        it("is NO-GO when the pin is not the verifier this build ships", () => {
            const other = createHash("sha256").update("another verifier build").digest("hex")
            const d = check(tlsnVerifiedPayload({ verifierWasmSha256: other }))
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain(`pins verifier ${other}, but this build ships`)
        })

        it("is NO-GO when the shipped verifier's sha256 file cannot be read", () => {
            const entry = { activationHeight: 0, ...tlsnVerifiedPayload() }
            expect(tlsnNotaryReasons(entry, null).join("\n")).toContain("verifier pin cannot be checked")
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlsn-sha-"))
            try {
                expect(committedVerifierSha256(path.join(dir, "missing.sha256"))).toBeNull()
                fs.writeFileSync(path.join(dir, "bad.sha256"), "not a digest\n")
                expect(committedVerifierSha256(path.join(dir, "bad.sha256"))).toBeNull()
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })

        it("does not check a pin the template leaves unset", () => {
            const entry = { activationHeight: 0, ...tlsnVerifiedPayload({ verifierWasmSha256: "FILL: sha256" }) }
            expect(tlsnNotaryReasons(entry, null).join("\n")).not.toContain("verifier pin cannot be checked")
        })

        it("ships the verifier the node loads", () => {
            expect(committedVerifierSha256()).toBe(TLSN_VERIFY_WASM_SHA256)
        })

        it("lists the devnet genesis keys as test keys", () => {
            const devnet = JSON.parse(
                fs.readFileSync(path.join(import.meta.dir, "../testing/devnet/genesis.devnet.json"), "utf8"),
            )
            for (const key of devnet.forks.tlsnVerified.notaryKeys) {
                expect(KNOWN_TEST_NOTARY_KEYS).toContain(key.hex)
            }
        })

        it("lists the secp256k1 keys of the TLSNotary test vectors as test keys", () => {
            const vectors = path.join(import.meta.dir, "../testing/tlsn-vectors")
            const trusted = JSON.parse(fs.readFileSync(path.join(vectors, "trusted-notary-keys.json"), "utf8"))
            const ephemeral = JSON.parse(
                fs.readFileSync(path.join(vectors, "default-notary-k256/output.json"), "utf8"),
            ).verifyingKey
            const k256 = [
                ...trusted.filter((k: { alg: string }) => k.alg === "k256").map((k: { publicKey: string }) => k.publicKey),
                ephemeral.hex,
            ]
            expect(ephemeral.alg).toBe("k256")
            expect(k256).toHaveLength(2)
            for (const hex of k256) expect(KNOWN_TEST_NOTARY_KEYS).toContain(hex)
        })
    })

    it("launches with the Storage Program fee kept in the supply", () => {
        expect(MAINNET_FORKS).toContain("storageFeeSettlement")
    })

    it("launches with a reference block room of 10", () => {
        expect(MAINNET_FORKS).toContain("referenceBlockRoom10")
    })

    it("is NO-GO on chain ids 0, 1, 1337 and 31337", () => {
        for (const chainId of REFUSED_MAINNET_CHAIN_IDS) {
            const genesis = { ...genesisFile(rows), properties: { id: chainId, shardSize: 10 } }
            const d = checkLaunch({ ...base, genesis, blockZero: blockZero(rows) })
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain(`genesis properties.id ${chainId} is`)
        }
    })

    it("is NO-GO without a genesis file, whose forks and validators it cannot check", () => {
        const d = checkLaunch({ ...base, genesis: null, blockZero: null, launchValidators: launch })
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("no genesis file")
    })

    describe("against the block 0 the genesis file builds", () => {
        const withFile = (o: Record<string, unknown>) =>
            checkLaunch({ ...base, genesis: genesisFile(rows), blockZero: blockZero(rows), ...o })

        it("is GO when --genesis-hash is that block 0", () => {
            const d = withFile({ genesisFileBlockHash: GENESIS, genesisFileProblems: [] })
            expect(d.reasons).toEqual([])
            expect(d.go).toBe(true)
        })

        it("is NO-GO when --genesis-hash is another block 0", () => {
            const d = withFile({ genesisFileBlockHash: "f".repeat(64), genesisFileProblems: [] })
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain(`--genesis-hash ${GENESIS} is not block 0 of the genesis file given`)
        })

        it("is NO-GO when the file's block 0 cannot be known", () => {
            const d = withFile({ genesisFileBlockHash: null, genesisFileProblems: ["genesis has no timestamp: x"] })
            expect(d.go).toBe(false)
            expect(d.reasons.join("\n")).toContain("cannot be known before launch")
            expect(d.reasons.join("\n")).toContain("a node would refuse this genesis at its first boot: genesis has no timestamp")
        })
    })

    it("draws the first committee under the genesis schedule of unpinnedCommittee", () => {
        // A pinned identity in a mainnet genesis is NO-GO anyway; the committee
        // reported beside that verdict must still be the node's
        const pinned = PINNED_SHARD_IDENTITIES[1]
        const all = [...launchSet(14).map(address => ({ address, status: "2", valid_at: 0 })), { address: pinned, status: "2", valid_at: 0 }]
        const unpinned = checkLaunch({ ...base, genesis: genesisFile(all), blockZero: blockZero(all) })
        const pinnedForks = { ...mainnetForks(), unpinnedCommittee: { activationHeight: null } }
        const legacy = checkLaunch({ ...base, genesis: genesisFile(all, pinnedForks), blockZero: blockZero(all) })
        expect(legacy.committee[0]).toBe(pinned)
        expect(unpinned.committee[0]).not.toBe(pinned)
        expect(unpinned.go).toBe(false)
        expect(unpinned.reasons.join("\n")).toContain(`launch validator is a pinned committee identity: ${pinned}`)
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

describe("commitSha", () => {
    it("takes the one SHA out of what a node reports", () => {
        expect(commitSha("stabilisation@E30EE46")).toBe("e30ee46")
        expect(commitSha(" e30ee460 ")).toBe("e30ee460")
        expect(commitSha("0xe30ee46")).toBe("e30ee46")
        // A tag with its own long hex or digit run must not hide the SHA
        expect(commitSha(`<v1.0.0-rc.4>${COMMIT}`)).toBe(COMMIT)
        expect(commitSha(`<release-20261115>${COMMIT}`)).toBe(COMMIT)
        expect(commitSha(`<deadbeef42>${COMMIT}`)).toBe(COMMIT)
        expect(commitSha("<v1.0.0-rc.4>")).toBeNull()
        expect(commitSha("<v1.0.0-rc.4>null")).toBeNull()
        expect(commitSha("stabilisation")).toBeNull()
        expect(commitSha("abc12")).toBeNull()
        expect(commitSha("abc1234-def5678")).toBeNull()
        expect(commitSha(null)).toBeNull()
    })

    it("never matches different commits", () => {
        expect(sameCommit("abc1234", "abc1235")).toBe(false)
        expect(sameCommit("stabilisation@abc1234", "abd")).toBe(false)
        expect(sameCommit(null, "abc1234")).toBe(false)
        expect(sameCommit("abc1234ff", "abc1234")).toBe(true)
        expect(sameCommit(`<20261115>${COMMIT}`, "2026111")).toBe(false)
    })
})

describe("launchGenesisExpectations", () => {
    it("derives the data hash and schedule digest the way a node reports them", async () => {
        const { launchGenesisExpectations } = await import("./launch-go-no-go")
        const { hashGenesisData } = await import("src/libs/blockchain/genesis/normalizeGenesisForHash")
        const genesis = {
            properties: { id: 7, shardSize: 10 },
            forks: Object.fromEntries(MAINNET_FORKS.map(f => [f, atZero(f, { description: "x" })])),
        }
        const a = await launchGenesisExpectations(genesis)
        expect(a.expectedGenesisDataHash).toBe(hashGenesisData(genesis))
        expect(a.requiredForks).toEqual(MAINNET_FORKS)
        // A description is not part of the schedule; a height is
        const b = await launchGenesisExpectations({
            ...genesis,
            forks: Object.fromEntries(MAINNET_FORKS.map(f => [f, atZero(f)])),
        })
        expect(b.expectedScheduleDigest).toBe(a.expectedScheduleDigest)
        const c = await launchGenesisExpectations({
            ...genesis,
            forks: { ...genesis.forks, commitLock: { activationHeight: 1 } },
        })
        expect(c.expectedScheduleDigest).not.toBe(a.expectedScheduleDigest)
    })

    it("builds block 0 from the file as the node does, and only with a fixed timestamp", async () => {
        const { launchGenesisExpectations } = await import("./launch-go-no-go")
        const { buildGenesisBlock } = await import("src/libs/blockchain/genesis/buildGenesisBlock")
        const genesis = {
            properties: { id: 7, shardSize: 10 },
            // Every fork declared: the node refuses a mainnet chain id that leaves one out
            forks: mainnetForks(),
            balances: [],
            timestamp: 1793318400,
        }
        const a = await launchGenesisExpectations(genesis)
        expect(a.genesisFileBlockHash).toBe(buildGenesisBlock(genesis).genesisBlock.hash)
        expect(a.genesisFileProblems).toEqual([])

        const { timestamp: _, ...noTimestamp } = genesis
        const b = await launchGenesisExpectations(noTimestamp)
        expect(b.genesisFileBlockHash).toBeNull()
        expect(b.genesisFileProblems.join("\n")).toContain("genesis has no timestamp")
    })
})

describe("command line", () => {
    const run = (args: string[]) => {
        const r = Bun.spawnSync(["bun", "scripts/launch-go-no-go.ts", ...args], { stdout: "pipe", stderr: "pipe" })
        return { code: r.exitCode, err: r.stderr.toString() }
    }
    const genesisPath = () => {
        const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
        const { join } = require("node:path") as typeof import("node:path")
        const { tmpdir } = require("node:os") as typeof import("node:os")
        const file = join(mkdtempSync(join(tmpdir(), "go-no-go-cli-")), "genesis.json")
        writeFileSync(file, JSON.stringify({ ...genesisFile([]), timestamp: 1793318400 }))
        return file
    }

    it("refuses a --shard-size that differs from the genesis", () => {
        const r = run(["--genesis", genesisPath(), "--shard-size", "4"])
        expect(r.code).toBe(2)
        expect(r.err).toContain("--shard-size 4 differs from the genesis properties.shardSize 10")
    }, 60_000)

    it("refuses a --genesis-hash or --commit that is not a hash", () => {
        const a = run(["--genesis", genesisPath(), "--genesis-hash", "genesis-a"])
        expect(a.code).toBe(2)
        expect(a.err).toContain("--genesis-hash must be 64 hex characters")
        const c = run(["--genesis", genesisPath(), "--expected-treasury", "0xab"])
        expect(c.code).toBe(2)
        expect(c.err).toContain("--expected-treasury must be 0x and 64 hex characters")
        const n = run(["--genesis", genesisPath(), "--expected-notary-keys", "demos-notary-1"])
        expect(n.code).toBe(2)
        expect(n.err).toContain("--expected-notary-keys entry 1 is not id:hex")
        const b = run(["--genesis", genesisPath(), "--commit", "stabilisation"])
        expect(b.code).toBe(2)
        expect(b.err).toContain("--commit must be a 7 to 40 character hex SHA")
    }, 60_000)
})

describe("parseArgs", () => {
    it("takes the genesis file and snapshot the node boots with when none are given", () => {
        const env = { DEMOS_GENESIS_FILE: "/srv/mainnet/genesis.json", DEMOS_SNAPSHOT_DIR: "/srv/mainnet/snapshot" }
        const args = parseArgs(["--operators", "ops.json"], env)
        expect(args.genesis).toBe("/srv/mainnet/genesis.json")
        expect(args.snapshot).toBe("/srv/mainnet/snapshot")
    })

    it("never pairs a file from the command line with one from the environment", () => {
        const env = { DEMOS_GENESIS_FILE: "/srv/g.json", DEMOS_SNAPSHOT_DIR: "/srv/snap" }
        expect(parseArgs(["--genesis", "a.json", "--snapshot", "s"], env)).toMatchObject({ genesis: "a.json", snapshot: "s" })
        expect(parseArgs(["--genesis", "a.json"], env)).toMatchObject({ genesis: "a.json", snapshot: null })
        expect(parseArgs(["--snapshot", "s"], env)).toMatchObject({ genesis: null, snapshot: "s" })
        expect(parseArgs(["--rpc", "http://v0:53550"], { DEMOS_SNAPSHOT_DIR: "/srv/snap" })).toMatchObject({ genesis: null, snapshot: null })
        expect(parseArgs([], {})).toMatchObject({ genesis: null, snapshot: null })
    })

    it("takes the agreed treasury from --expected-treasury, else from DEMOS_EXPECTED_TREASURY", () => {
        const env = { DEMOS_EXPECTED_TREASURY: TREASURY }
        expect(parseArgs(["--expected-treasury", "0x" + "cd".repeat(32)], env).expectedTreasury).toBe("0x" + "cd".repeat(32))
        expect(parseArgs([], env).expectedTreasury).toBe(TREASURY)
        expect(parseArgs([], {}).expectedTreasury).toBeNull()
        expect(() => parseArgs(["--expected-treasury"], {})).toThrow("--expected-treasury needs a value")
    })

    it("takes the agreed notary keys from --expected-notary-keys, else from DEMOS_EXPECTED_NOTARY_KEYS", () => {
        const env = { DEMOS_EXPECTED_NOTARY_KEYS: NOTARY_KEYS }
        const other = `demos-notary-1:${notaryKeyHex(0x33)}`
        expect(parseArgs(["--expected-notary-keys", other], env).expectedNotaryKeys).toBe(other)
        expect(parseArgs([], env).expectedNotaryKeys).toBe(NOTARY_KEYS)
        expect(parseArgs([], {}).expectedNotaryKeys).toBeNull()
        expect(() => parseArgs(["--expected-notary-keys"], {})).toThrow("--expected-notary-keys needs a value")
    })
})
