import { describe, expect, it } from "bun:test"
import {
    type DenominationInputs,
    type LaunchExpectation,
    type NodeObservation,
    buildExpectation,
    decideHeight1,
    denominationScales,
    parseAmount,
    parseReplyAmount,
} from "./launch-height1-check"

const id = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")
const BLOCK0 = "a".repeat(64)
const BLOCK1 = "b".repeat(64)
const STAKE = 1_000_000_000_000n

/** A post-fork snapshot: values are already in OS, nothing is scaled. */
const MIGRATED: DenominationInputs = {
    snapshotPath: true,
    osEffectiveHeight: 0,
    snapshotOsApplied: true,
}

function expectation(overrides: Partial<LaunchExpectation> = {}): LaunchExpectation {
    return buildExpectation({
        genesisHash: BLOCK0,
        genesis: { balances: [[id(100), "5000"]] },
        validatorRows: [0, 1, 2].map(i => ({
            address: id(i),
            status: "2",
            valid_at: 0,
            connection_url: `http://v${i}:53550`,
            staked_amount: STAKE.toString(),
        })) as any,
        validatorSource: "snapshot",
        snapshotBalances: [
            { pubkey: id(50), balance: 700n },
            // genesis.balances overrides the snapshot row of the same account
            { pubkey: id(100), balance: 1n },
        ],
        denomination: MIGRATED,
        ...overrides,
    } as any) as LaunchExpectation
}

function node(i: number, overrides: Partial<NodeObservation> = {}): NodeObservation {
    return {
        url: `http://v${i}:53550`,
        reachable: true,
        genesisHash: BLOCK0,
        head: 1,
        blocks: [{ number: 1, hash: BLOCK1, previousHash: BLOCK0, txCount: 0 }],
        validators: [0, 1, 2].map(j => ({
            address: id(j),
            status: "2",
            stakedAmount: STAKE.toString(),
            validAt: 0,
        })),
        balances: { [id(50)]: "700", [id(100)]: "5000" },
        ...overrides,
    }
}

const failed = (d: ReturnType<typeof decideHeight1>) => d.checks.filter(c => c.status === "fail")

describe("decideHeight1", () => {
    it("passes when every node holds the published state on the agreed block 0", () => {
        const d = decideHeight1(expectation(), [node(0), node(1), node(2)])
        expect(failed(d)).toEqual([])
        expect(d.verdict).toBe("pass")
        expect(d.checks.find(c => c.name === "block-1-agreement")?.status).toBe("pass")
    })

    it("fails on another block 0", () => {
        const d = decideHeight1(expectation(), [node(0, { genesisHash: "c".repeat(64) })])
        expect(d.verdict).toBe("fail")
        expect(failed(d).map(c => c.name)).toContain("block-0")
    })

    it("fails when block 1 does not build on block 0, or nodes hold different blocks 1", () => {
        const wrongParent = decideHeight1(expectation(), [
            node(0, { blocks: [{ number: 1, hash: BLOCK1, previousHash: "d".repeat(64), txCount: 0 }] }),
        ])
        expect(failed(wrongParent).map(c => c.name)).toContain("block-1-parent")
        const split = decideHeight1(expectation(), [
            node(0),
            node(1, { blocks: [{ number: 1, hash: "e".repeat(64), previousHash: BLOCK0, txCount: 0 }] }),
        ])
        expect(failed(split).map(c => c.name)).toContain("block-1-agreement")
    })

    it("fails while the chain is still at block 0", () => {
        const d = decideHeight1(expectation(), [node(0, { head: 0, blocks: [] })])
        expect(failed(d).map(c => c.name)).toEqual(["head"])
    })

    it("fails on a missing validator", () => {
        const d = decideHeight1(expectation(), [node(0, { validators: node(0).validators!.slice(0, 2) })])
        expect(failed(d)[0].detail).toContain(`missing from the chain: ${id(2)}`)
    })

    it("fails on an extra validator", () => {
        const extra = { address: id(9), status: "2", stakedAmount: STAKE.toString(), validAt: 0 }
        const d = decideHeight1(expectation(), [node(0, { validators: [...node(0).validators!, extra] })])
        expect(failed(d)[0].detail).toContain(`not in the genesis: ${id(9)}`)
    })

    it("fails on a changed stake and names a 10^9 difference", () => {
        const validators = node(0).validators!.map((v, i) =>
            i === 1 ? { ...v, stakedAmount: (STAKE * 1_000_000_000n).toString() } : v,
        )
        const d = decideHeight1(expectation(), [node(0, { validators })])
        expect(failed(d)[0].name).toBe("validators")
        expect(failed(d)[0].detail).toContain("off by 10^9")
    })

    it("fails on a wrong or unreadable balance", () => {
        const wrong = decideHeight1(expectation(), [node(0, { balances: { [id(50)]: "701", [id(100)]: "5000" } })])
        expect(failed(wrong)[0].detail).toContain(`${id(50)} has 701, expected 700`)
        const unread = decideHeight1(expectation(), [node(0, { balances: { [id(50)]: "700", [id(100)]: null } })])
        expect(failed(unread)[0].detail).toContain("could not be read")
    })

    it("skips the state comparison once a block carries transactions, and is inconclusive alone", () => {
        const d = decideHeight1(expectation(), [
            node(0, {
                head: 2,
                blocks: [
                    { number: 1, hash: BLOCK1, previousHash: BLOCK0, txCount: 0 },
                    { number: 2, hash: "f".repeat(64), previousHash: BLOCK1, txCount: 3 },
                ],
                // A balance that moved through block 2 is no evidence against the genesis
                balances: { [id(50)]: "1", [id(100)]: "1" },
            }),
        ])
        const state = d.checks.filter(c => c.name === "validators" || c.name === "balances")
        expect(state.map(c => c.status)).toEqual(["skip", "skip"])
        expect(state[0].detail).toContain("block 2 has 3 transactions")
        expect(failed(d)).toEqual([])
        expect(d.verdict).toBe("inconclusive")
    })

    it("skips past the scan window", () => {
        const d = decideHeight1(expectation(), [node(0, { head: 50 })], { maxScan: 20 })
        expect(d.checks.find(c => c.name === "balances")?.detail).toContain("past the first 20 blocks")
        expect(d.verdict).toBe("inconclusive")
    })

    it("is inconclusive when one node could not be fully checked, even if the others pass", () => {
        const noBlock1 = decideHeight1(expectation(), [node(0), node(1, { blocks: [] })])
        expect(failed(noBlock1)).toEqual([])
        expect(noBlock1.verdict).toBe("inconclusive")

        const noHash = decideHeight1(expectation(), [
            node(0),
            node(1, { blocks: [{ number: 1, hash: null, previousHash: BLOCK0, txCount: 0 }] as any }),
        ])
        expect(noHash.checks.find(c => c.node === "http://v1:53550" && c.name === "block-1-agreement")?.status).toBe("skip")
        expect(noHash.verdict).toBe("inconclusive")

        const stateSkipped = decideHeight1(expectation(), [node(0), node(1, { head: 50 })], { maxScan: 20 })
        expect(stateSkipped.verdict).toBe("inconclusive")
    })

    it("fails on an unreachable node", () => {
        const d = decideHeight1(expectation(), [node(0), { url: "http://v1:53550", reachable: false, error: "timeout" }])
        expect(d.verdict).toBe("fail")
        expect(failed(d)[0]).toMatchObject({ name: "reachable", detail: "timeout" })
    })
})

describe("denominationScales", () => {
    it("scales nothing for a migrated snapshot whose genesis lists osDenomination", () => {
        expect(denominationScales(MIGRATED, 1)).toEqual({ balance: 1n, snapshotStake: 1n, genesisStake: 1n })
    })

    it("migrates a pre-fork snapshot at block 0, before genesis validators are seeded", () => {
        const s = denominationScales({ ...MIGRATED, snapshotOsApplied: false }, 1)
        expect(s).toEqual({ balance: 1_000_000_000n, snapshotStake: 1_000_000_000n, genesisStake: 1n })
    })

    it("scales nothing while osDenomination is inactive", () => {
        const pre = { ...MIGRATED, snapshotOsApplied: false }
        const none = { balance: 1n, snapshotStake: 1n, genesisStake: 1n }
        expect(denominationScales({ ...pre, osEffectiveHeight: null }, 1)).toEqual(none)
        expect(denominationScales({ ...pre, osEffectiveHeight: 5 }, 1)).toEqual(none)
    })

    it("migrates everything through the block hook once a later height is reached", () => {
        const s = denominationScales({ ...MIGRATED, snapshotOsApplied: false, osEffectiveHeight: 5 }, 5)
        expect(s).toEqual({ balance: 1_000_000_000n, snapshotStake: 1_000_000_000n, genesisStake: 1_000_000_000n })
    })

    it("on the legacy path the block hook migrates block 0 too", () => {
        const s = denominationScales({ snapshotPath: false, osEffectiveHeight: 0, snapshotOsApplied: false }, 1)
        expect(s).toEqual({ balance: 1_000_000_000n, snapshotStake: 1_000_000_000n, genesisStake: 1_000_000_000n })
    })

    it("expects the scaled value on chain for a pre-fork snapshot", () => {
        const e = expectation({ denomination: { ...MIGRATED, snapshotOsApplied: false } } as any)
        const scaled = node(0, {
            validators: node(0).validators!.map(v => ({ ...v, stakedAmount: (STAKE * 1_000_000_000n).toString() })),
            balances: { [id(50)]: "700000000000", [id(100)]: "5000000000000" },
        })
        expect(failed(decideHeight1(e, [scaled]))).toEqual([])
    })
})

describe("parseAmount", () => {
    it("reads the shapes a genesis or snapshot amount is written in", () => {
        expect(parseAmount("12")).toBe(12n)
        expect(parseAmount("12n")).toBe(12n)
        expect(parseAmount(12)).toBe(12n)
        expect(parseAmount(2 ** 60)).toBeNull()
        expect(parseAmount("1.5")).toBeNull()
        expect(parseAmount(null)).toBeNull()
    })
})

describe("parseReplyAmount", () => {
    it("accepts only the decimal string the node sends", () => {
        expect(parseReplyAmount("12")).toBe(12n)
        expect(parseReplyAmount("0")).toBe(0n)
        expect(parseReplyAmount("12n")).toBeNull()
        expect(parseReplyAmount(12)).toBeNull()
        expect(parseReplyAmount("-1")).toBeNull()
        expect(parseReplyAmount("1e3")).toBeNull()
        expect(parseReplyAmount(" 12")).toBeNull()
        expect(parseReplyAmount(undefined)).toBeNull()
    })

    it("reports a balance in another shape as unreadable", () => {
        const d = decideHeight1(expectation(), [node(0, { balances: { [id(50)]: "700", [id(100)]: 5000 } })])
        expect(d.verdict).toBe("fail")
        expect(failed(d).map(c => c.detail).join("\n")).toContain("could not be read")
    })
})
