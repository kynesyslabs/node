/**
 * Bootstrap decision when a peer's genesis data hash differs from ours
 * (src/libs/peer/routines/genesisMismatch.ts).
 *
 * The scenario that matters: an operator schedules a fork on a running chain
 * by editing data/genesis.json, while every peer still serves the genesis block
 * stored when the chain was created. The edited file must survive peering.
 */

import { describe, it, expect } from "bun:test"
import { resolveGenesisMismatch } from "src/libs/peer/routines/genesisMismatch"
import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"

const VALIDATORS = [
    { address: "0xaa", status: "2", connection_url: "http://node-1:1", staked_amount: "1" },
]
const stored = {
    properties: { name: "DEVNET", currency: "DEM" },
    forks: { osDenomination: { activationHeight: 0 } },
    balances: [],
    validators: VALIDATORS,
}
const edited = {
    ...stored,
    properties: { ...stored.properties, id: 31337 },
    forks: {
        ...stored.forks,
        signatureDomain: { activationHeight: 40 },
        web2ProofBinding: { activationHeight: 40 },
    },
}

function deps(served: unknown | null, fileAfterWrite?: unknown) {
    const written: unknown[] = []
    return {
        written,
        deps: {
            fetchPeerGenesis: async () => served,
            writeGenesis: (d: unknown) => written.push(d),
            hashLocalFile: () => hashGenesisData(fileAfterWrite ?? written[written.length - 1]),
            hash: hashGenesisData,
        },
    }
}

describe("resolveGenesisMismatch", () => {
    it("does nothing when the hashes are equal", async () => {
        const h = hashGenesisData(stored)
        const { deps: d, written } = deps(stored)
        expect(await resolveGenesisMismatch(h, h, d)).toEqual({ outcome: "match" })
        expect(written).toHaveLength(0)
    })

    it("keeps an edited file that differs from the stored genesis only in the fork schedule and chain id", async () => {
        // The peer's hash may come from a build that still hashes forks: model it as different.
        const { deps: d, written } = deps(stored)
        const verdict = await resolveGenesisMismatch(hashGenesisData(edited), "peer-hash-with-forks", d)
        expect(verdict.outcome).toBe("unhashed-fields-only")
        expect(written).toHaveLength(0)
    })

    it("replaces the file when the genesis data really differs", async () => {
        const other = { ...stored, balances: [["0xab", "5"]] }
        const { deps: d, written } = deps(other)
        const verdict = await resolveGenesisMismatch(hashGenesisData(edited), hashGenesisData(other), d)
        expect(verdict).toEqual({ outcome: "replaced", servedHash: hashGenesisData(other) })
        expect(written).toEqual([other])
    })

    it("fails when the peer's genesis cannot be fetched", async () => {
        const { deps: d } = deps(null)
        await expect(resolveGenesisMismatch("a", "b", d)).rejects.toThrow("Failed to download")
    })

    it("fails when the file read back after the write does not hash like what was served", async () => {
        const other = { ...stored, balances: [["0xab", "5"]] }
        const { deps: d } = deps(other, stored)
        await expect(resolveGenesisMismatch(hashGenesisData(edited), "x", d)).rejects.toThrow(
            "mismatch after download",
        )
    })
})
