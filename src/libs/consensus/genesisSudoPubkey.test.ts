import { describe, expect, it } from "bun:test"
import { hashGenesisData } from "@/libs/blockchain/genesis/normalizeGenesisForHash"
import { GenesisSudoPubkeyError, readGenesisSudoPubkey } from "./genesisSudoPubkey"

const KEY = "0x" + "5d".repeat(32)
const genesis = (sudoPubkey?: unknown) => ({
    properties: { id: 1, name: "DEMOS", currency: "DEM", shardSize: 10, ...(sudoPubkey === undefined ? {} : { sudoPubkey }) },
})

describe("readGenesisSudoPubkey", () => {
    it("reads the declared award signer", () => {
        expect(readGenesisSudoPubkey(genesis(KEY))).toBe(KEY)
    })

    it("treats a genesis that declares none as having no signer", () => {
        expect(readGenesisSudoPubkey(genesis())).toBeNull()
        expect(readGenesisSudoPubkey(genesis(null))).toBeNull()
        expect(readGenesisSudoPubkey({})).toBeNull()
        expect(readGenesisSudoPubkey(null)).toBeNull()
    })

    it("refuses a value that is not a lowercase 32-byte hex address", () => {
        for (const bad of ["", "0x12", KEY.toUpperCase().replace("0X", "0x"), KEY.slice(2), 5, {}]) {
            expect(() => readGenesisSudoPubkey(genesis(bad))).toThrow(GenesisSudoPubkeyError)
        }
    })

    it("is covered by the genesis hash every peer compares", () => {
        expect(hashGenesisData(genesis(KEY))).not.toBe(hashGenesisData(genesis()))
        expect(hashGenesisData(genesis(KEY))).not.toBe(hashGenesisData(genesis("0x" + "5e".repeat(32))))
    })
})
