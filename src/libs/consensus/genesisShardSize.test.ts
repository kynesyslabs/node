import { describe, expect, it } from "bun:test"
import {
    GenesisShardSizeError,
    readGenesisShardSize,
    SHARD_SIZE_MAX,
    SHARD_SIZE_MIN,
} from "./genesisShardSize"

const genesis = (shardSize: unknown) => ({
    properties: { id: 1, name: "DEMOS", currency: "DEM", shardSize },
})

describe("readGenesisShardSize", () => {
    it("returns the committed value", () => {
        expect(readGenesisShardSize(genesis(10))).toBe(10)
    })

    it("accepts the bounds inclusively", () => {
        expect(readGenesisShardSize(genesis(SHARD_SIZE_MIN))).toBe(
            SHARD_SIZE_MIN,
        )
        expect(readGenesisShardSize(genesis(SHARD_SIZE_MAX))).toBe(
            SHARD_SIZE_MAX,
        )
    })

    it("rejects a missing field instead of falling back", () => {
        expect(() =>
            readGenesisShardSize({ properties: { id: 1 } }),
        ).toThrow(GenesisShardSizeError)
        expect(() => readGenesisShardSize({ properties: { id: 1 } })).toThrow(
            /missing/,
        )
    })

    it("rejects a missing properties object", () => {
        expect(() => readGenesisShardSize({})).toThrow(GenesisShardSizeError)
        expect(() => readGenesisShardSize(null)).toThrow(GenesisShardSizeError)
        expect(() => readGenesisShardSize("x")).toThrow(GenesisShardSizeError)
    })

    it("rejects non-integer values", () => {
        for (const bad of ["10", 4.5, NaN, null, true, {}]) {
            expect(() => readGenesisShardSize(genesis(bad))).toThrow(
                GenesisShardSizeError,
            )
        }
    })

    it("rejects values outside the bounds", () => {
        expect(() =>
            readGenesisShardSize(genesis(SHARD_SIZE_MIN - 1)),
        ).toThrow(/within/)
        expect(() =>
            readGenesisShardSize(genesis(SHARD_SIZE_MAX + 1)),
        ).toThrow(/within/)
    })
})
