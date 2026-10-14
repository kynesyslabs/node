/**
 * Bootstrap decision when the genesis data hash a peer advertises differs from
 * ours (src/libs/peer/routines/genesisMismatch.ts), on real genesis files and
 * with the real hash functions, for every pairing of builds:
 *
 *   new node / old anchor, old node / new anchor, new / new with the same data,
 *   new / new with different data.
 *
 * An old build advertises and compares the full hash and, on a mismatch,
 * overwrites its file with what the peer serves. A new anchor must therefore
 * advertise and serve exactly what an old one does.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { resolveGenesisMismatch, type GenesisMismatchDeps } from "src/libs/peer/routines/genesisMismatch"
import {
    hashGenesisCore,
    hashGenesisData,
    stableStringify,
} from "src/libs/blockchain/genesis/normalizeGenesisForHash"
import Hashing from "src/libs/crypto/hashing"

// The hash and the resolver as the previous build had them: full hash only, and
// on any mismatch overwrite the file and compare the written file with what the
// peer advertised.
function legacyHash(data: any): string {
    const canonical: Record<string, unknown> = {}
    for (const k of Object.keys(data)) if (k !== "validators") canonical[k] = data[k]
    if (Array.isArray(data.validators)) {
        canonical.validators = data.validators
            .map((v: any) => {
                const { connection_url: _c, ...rest } = v
                return rest
            })
            .sort((a: any, b: any) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
    }
    return Hashing.sha256(stableStringify(canonical))
}
function legacyResolve(ownFile: any, advertised: string, served: any): { file: any; outcome: string } {
    if (advertised === legacyHash(ownFile)) return { file: ownFile, outcome: "match" }
    if (legacyHash(served) !== advertised) throw new Error("Genesis data hash mismatch after download")
    return { file: served, outcome: "replaced" }
}

const load = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const chains = {
    production: load("data/genesis.json"),
    devnet: load("testing/devnet/genesis.devnet.json"),
}

/** What an operator does on a running chain: add the schedule and the chain id to the file. */
function withSchedule(genesis: any) {
    const edited = structuredClone(genesis)
    edited.properties = { ...edited.properties, id: 31337 }
    edited.forks = {
        ...edited.forks,
        signatureDomain: { activationHeight: 40 },
        web2ProofBinding: { activationHeight: 40 },
    }
    return edited
}

function newDeps(own: any, served: any) {
    const state = { file: structuredClone(own), writes: 0 }
    const deps: GenesisMismatchDeps = {
        fetchPeerGenesis: async () => structuredClone(served),
        readLocalGenesis: () => structuredClone(state.file),
        writeGenesis: d => {
            state.file = structuredClone(d)
            state.writes++
        },
        hashFull: hashGenesisData,
        hashCore: hashGenesisCore,
    }
    return { state, deps }
}
const decide = (own: any, anchorStored: any) => {
    const { state, deps } = newDeps(own, anchorStored)
    // An anchor advertises the full hash of the block it stored and serves that block.
    return resolveGenesisMismatch(hashGenesisData(own), hashGenesisCore(own), hashGenesisData(anchorStored), deps).then(
        verdict => ({ verdict, state }),
    )
}

describe.each(Object.entries(chains))("genesis mismatch on the %s genesis", (_name, stored) => {
    it("the advertised hash is the previous build's hash, byte for byte", () => {
        expect(hashGenesisData(stored)).toBe(legacyHash(stored))
        expect(hashGenesisData(withSchedule(stored))).toBe(legacyHash(withSchedule(stored)))
    })

    it("new node, old anchor: the edited file is kept", async () => {
        // The old anchor advertises the full hash of what it stored, which has no new schedule.
        const edited = withSchedule(stored)
        const { verdict, state } = await decide(edited, stored)
        expect(verdict.outcome).toBe("unhashed-fields-only")
        expect(state.writes).toBe(0)
        expect(state.file).toEqual(edited)
    })

    it("old node, new anchor: boots exactly as it does against an old anchor", () => {
        // The new anchor advertises hashGenesisData(stored) and serves stored: the same as an old
        // one. The old node's result (it overwrites its file, the known old-build behaviour) is
        // therefore unchanged and it does not throw.
        const edited = withSchedule(stored)
        const advertised = hashGenesisData(stored)
        expect(advertised).toBe(legacyHash(stored))
        const result = legacyResolve(edited, advertised, stored)
        expect(result.outcome).toBe("replaced")
        expect(result.file).toEqual(stored)
    })

    it("new node, new anchor, same data: nothing to do", async () => {
        const { verdict, state } = await decide(structuredClone(stored), structuredClone(stored))
        expect(verdict).toEqual({ outcome: "match" })
        expect(state.writes).toBe(0)
    })

    it("new node, new anchor, same data but an edited schedule on this node: the file is kept", async () => {
        const edited = withSchedule(stored)
        const { verdict, state } = await decide(edited, stored)
        expect(verdict.outcome).toBe("unhashed-fields-only")
        expect(state.file).toEqual(edited)
    })

    it("new node, new anchor, different data: converges and keeps the local schedule and chain id", async () => {
        const other = structuredClone(stored)
        other.balances = [...(other.balances ?? []), ["0x" + "ab".repeat(32), "7"]]
        const edited = withSchedule(stored)
        const { verdict, state } = await decide(edited, other)
        expect(verdict.outcome).toBe("replaced")
        if (verdict.outcome !== "replaced") throw new Error("unreachable")
        expect(verdict.carriedOver).toEqual(["forks", "properties.id"])
        expect(state.file.balances).toEqual(other.balances)
        expect(state.file.forks.signatureDomain).toEqual({ activationHeight: 40 })
        expect(state.file.forks.web2ProofBinding).toEqual({ activationHeight: 40 })
        expect(state.file.properties.id).toBe(31337)
        expect(hashGenesisCore(state.file)).toBe(hashGenesisCore(other))
        expect(verdict.writtenFullHash).toBe(hashGenesisData(state.file))
    })

    it("new node, new anchor, different data, no local schedule: carries nothing over", async () => {
        const other = structuredClone(stored)
        other.balances = [...(other.balances ?? []), ["0x" + "cd".repeat(32), "9"]]
        const local = structuredClone(stored)
        delete local.forks
        delete local.properties.id
        const { verdict } = await decide(local, other)
        expect(verdict.outcome).toBe("replaced")
        if (verdict.outcome !== "replaced") throw new Error("unreachable")
        expect(verdict.carriedOver).toEqual([])
    })
})

describe("what an anchor serves must hash to what it advertised", () => {
    it("fails when the served data hashes differently", async () => {
        const stored = chains.devnet
        const { deps } = newDeps(withSchedule(stored), chains.production)
        await expect(
            resolveGenesisMismatch(
                hashGenesisData(withSchedule(stored)),
                hashGenesisCore(withSchedule(stored)),
                hashGenesisData(stored),
                deps,
            ),
        ).rejects.toThrow("mismatch after download")
    })

    it("fails when the data cannot be fetched", async () => {
        const { deps } = newDeps(chains.devnet, chains.devnet)
        deps.fetchPeerGenesis = async () => null
        await expect(resolveGenesisMismatch("a", "b", "c", deps)).rejects.toThrow("Failed to download")
    })
})
