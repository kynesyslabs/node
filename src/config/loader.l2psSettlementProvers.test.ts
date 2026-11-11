import { afterEach, describe, expect, it } from "bun:test"
import { loadConfig } from "./loader"

const saved = process.env.L2PS_SETTLEMENT_PROVERS

afterEach(() => {
    if (saved === undefined) delete process.env.L2PS_SETTLEMENT_PROVERS
    else process.env.L2PS_SETTLEMENT_PROVERS = saved
})

describe("L2PS settlement prover pool size", () => {
    it("defaults to one subprocess", () => {
        delete process.env.L2PS_SETTLEMENT_PROVERS
        expect(loadConfig().l2ps.settlementProvers).toBe(1)
    })

    it("takes the configured size", () => {
        process.env.L2PS_SETTLEMENT_PROVERS = "4"
        expect(loadConfig().l2ps.settlementProvers).toBe(4)
    })

    it("never goes below one: a member without a prover could not settle its batches", () => {
        for (const value of ["0", "-2"]) {
            process.env.L2PS_SETTLEMENT_PROVERS = value
            expect(loadConfig().l2ps.settlementProvers).toBe(1)
        }
    })
})
