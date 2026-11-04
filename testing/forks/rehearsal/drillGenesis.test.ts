import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"
import { withDevnetValidators } from "./lib/drillGenesis"

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const PUBKEYS = [key(0xa1), key(0xa2), key(0xa3), key(0xa4)]
const PORTS = ["53551", "53553", "53555", "53557"]
const STAKE = "1000000000000000000"

const FORKS = {
    osDenomination: { activationHeight: 5, description: "low" },
    quorumParity: { activationHeight: 0, description: "q" },
    committeeBinding: { activationHeight: 0, description: "c" },
    commitLock: { activationHeight: 0, description: "l" },
}

function genesis() {
    return {
        properties: { id: 1, name: "DEMOS", currency: "DEM", shardSize: 4 },
        mutables: { minBlocksForValidationOnlineStatus: 4 },
        balances: [
            [key(0x01), "5"],
            [PUBKEYS[1], "7"],
            [key(0x02), "9"],
        ],
        timestamp: "1692734616",
        status: "confirmed",
        forks: FORKS,
    } as Record<string, any>
}

describe("withDevnetValidators", () => {
    it("lists the given pubkeys in order with the generate-genesis.sh entry shape", () => {
        const out = withDevnetValidators(genesis(), PUBKEYS, PORTS, STAKE)
        expect(out.validators).toEqual([
            {
                address: PUBKEYS[0],
                status: "2",
                connection_url: "http://node-1:53551",
                staked_amount: STAKE,
                first_seen: 0,
                valid_at: 0,
            },
            {
                address: PUBKEYS[1],
                status: "2",
                connection_url: "http://node-2:53553",
                staked_amount: STAKE,
                first_seen: 0,
                valid_at: 0,
            },
            {
                address: PUBKEYS[2],
                status: "2",
                connection_url: "http://node-3:53555",
                staked_amount: STAKE,
                first_seen: 0,
                valid_at: 0,
            },
            {
                address: PUBKEYS[3],
                status: "2",
                connection_url: "http://node-4:53557",
                staked_amount: STAKE,
                first_seen: 0,
                valid_at: 0,
            },
        ])
    })

    it("uses the ports it is given", () => {
        const out = withDevnetValidators(genesis(), PUBKEYS, ["1", "2", "3", "4"], STAKE)
        expect(out.validators.map((v: any) => v.connection_url)).toEqual([
            "http://node-1:1",
            "http://node-2:2",
            "http://node-3:3",
            "http://node-4:4",
        ])
    })

    it("funds every validator with the stake", () => {
        const out = withDevnetValidators(genesis(), PUBKEYS, PORTS, STAKE)
        const balances = new Map<string, string>(out.balances)
        for (const pubkey of PUBKEYS) expect(balances.get(pubkey)).toBe(STAKE)
    })

    it("replaces a colliding balance once and keeps the others", () => {
        const out = withDevnetValidators(genesis(), PUBKEYS, PORTS, STAKE)
        expect(out.balances.filter((p: string[]) => p[0] === PUBKEYS[1])).toEqual([
            [PUBKEYS[1], STAKE],
        ])
        expect(out.balances).toContainEqual([key(0x01), "5"])
        expect(out.balances).toContainEqual([key(0x02), "9"])
        expect(out.balances).toHaveLength(PUBKEYS.length + 2)
    })

    it("treats addresses that differ only in case as colliding", () => {
        const g = genesis()
        g.balances = [[PUBKEYS[0].toUpperCase().replace("0X", "0x"), "3"]]
        const out = withDevnetValidators(g, PUBKEYS, PORTS, STAKE)
        expect(out.balances).toHaveLength(PUBKEYS.length)
    })

    it("leaves forks, shardSize and the rest of the genesis untouched", () => {
        const out = withDevnetValidators(genesis(), PUBKEYS, PORTS, STAKE)
        expect(out.forks).toEqual(FORKS)
        expect(out.forks.osDenomination.activationHeight).toBe(5)
        expect(out.properties).toEqual(genesis().properties)
        expect(out.properties.shardSize).toBe(4)
        expect(out.mutables).toEqual(genesis().mutables)
        expect(out.timestamp).toBe("1692734616")
        expect(out.status).toBe("confirmed")
    })

    it("does not modify its input", () => {
        const g = genesis()
        withDevnetValidators(g, PUBKEYS, PORTS, STAKE)
        expect(g).toEqual(genesis())
    })

    it("replaces validators already in the genesis", () => {
        const g = genesis()
        g.validators = [{ address: key(0xff) }]
        const out = withDevnetValidators(g, PUBKEYS, PORTS, STAKE)
        expect(out.validators.map((v: any) => v.address)).toEqual(PUBKEYS)
    })

    it("works on a genesis with no balances", () => {
        const g = genesis()
        delete g.balances
        const out = withDevnetValidators(g, PUBKEYS, PORTS, STAKE)
        expect(out.balances).toEqual(PUBKEYS.map(p => [p, STAKE]))
    })

    it("refuses input the node would refuse", () => {
        expect(() => withDevnetValidators(genesis(), [], [], STAKE)).toThrow()
        expect(() => withDevnetValidators(genesis(), PUBKEYS, PORTS.slice(1), STAKE)).toThrow()
        expect(() =>
            withDevnetValidators(genesis(), ["0xabc", ...PUBKEYS.slice(1)], PORTS, STAKE),
        ).toThrow(/0x \+ 64 hex/)
        expect(() =>
            withDevnetValidators(genesis(), [PUBKEYS[0], PUBKEYS[0]], PORTS.slice(0, 2), STAKE),
        ).toThrow(/duplicate/)
    })
})

describe("scenario 12 stages the drill genesis from the regenerated identities", () => {
    const src = readFileSync(
        resolve(import.meta.dir, "scenarios/12-quorum-loss-halt-recovery.ts"),
        "utf8",
    )
    it("regenerates identities before it stages the genesis", () => {
        const regenerate = src.indexOf("regenerateIdentities(NODE_IDS.length)")
        const stage = src.indexOf("\n    const genesis = buildDrillGenesis()")
        expect(regenerate).toBeGreaterThan(-1)
        expect(stage).toBeGreaterThan(regenerate)
    })
    it("builds the genesis with the devnet validators", () => {
        expect(src).toContain("withCurrentDevnetValidators(")
    })
})
