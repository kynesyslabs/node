/**
 * Boot checks of the genesis against the pinned hash
 * (src/libs/blockchain/genesis/genesisPin.ts), on the repository's genesis file
 * and with the real hash functions.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import {
    GenesisRefusal,
    declaredManifestHash,
    freshGenesisProblems,
    parseGenesisPin,
    parseStoredGenesisData,
    pinRequirementProblem,
    restartGenesisProblems,
} from "src/libs/blockchain/genesis/genesisPin"
import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"

const MANIFEST = "a".repeat(64)

function launchGenesis(): Record<string, any> {
    const data = JSON.parse(readFileSync("data/genesis.json", "utf8"))
    return {
        ...data,
        properties: { ...(data.properties ?? {}), id: 7 },
        forks: { signatureDomain: { activationHeight: 0 } },
        snapshot: { manifestSha256: MANIFEST },
    }
}

describe("parseGenesisPin", () => {
    const hash = "ab".repeat(32)

    it("accepts the forms operators paste", () => {
        expect(parseGenesisPin(hash)).toBe(hash)
        expect(parseGenesisPin(`0x${hash.toUpperCase()}\n`)).toBe(hash)
        expect(parseGenesisPin(`  ${hash}  `)).toBe(hash)
    })

    it("treats unset and blank as no pin", () => {
        expect(parseGenesisPin(undefined)).toBe("")
        expect(parseGenesisPin("  ")).toBe("")
    })

    it("refuses a value that cannot be a sha256", () => {
        expect(() => parseGenesisPin(hash.slice(1))).toThrow(GenesisRefusal)
        expect(() => parseGenesisPin(`${hash}00`)).toThrow(GenesisRefusal)
        expect(() => parseGenesisPin("z".repeat(64))).toThrow(GenesisRefusal)
    })
})

describe("pinRequirementProblem", () => {
    it("requires a pin in production", () => {
        expect(pinRequirementProblem("", { NODE_ENV: "production" })).toContain(
            "EXPECTED_GENESIS_HASH",
        )
    })

    it("allows an explicit opt-out, development, or a set pin", () => {
        expect(
            pinRequirementProblem("", {
                NODE_ENV: "production",
                DEMOS_ALLOW_UNPINNED_GENESIS: "true",
            }),
        ).toBeNull()
        expect(pinRequirementProblem("", { NODE_ENV: "development" })).toBeNull()
        expect(pinRequirementProblem("ab".repeat(32), { NODE_ENV: "production" })).toBeNull()
    })
})

describe("freshGenesisProblems", () => {
    const genesis = launchGenesis()
    const pin = hashGenesisData(genesis)
    const ok = { genesisData: genesis, pin, restore: false, snapshotManifestHash: MANIFEST }

    it("passes the launch genesis with its snapshot", () => {
        expect(freshGenesisProblems(ok)).toEqual([])
    })

    it("covers the snapshot declaration with the pin", () => {
        const other = { ...genesis, snapshot: { manifestSha256: "b".repeat(64) } }
        expect(hashGenesisData(other)).not.toBe(pin)
    })

    it("refuses a genesis that differs by one byte", () => {
        const edited = JSON.parse(JSON.stringify(genesis))
        edited.timestamp = String(Number(edited.timestamp) + 1)
        const problems = freshGenesisProblems({ ...ok, genesisData: edited })
        expect(problems.join()).toContain("EXPECTED_GENESIS_HASH")
    })

    it("refuses a moved fork", () => {
        const edited = { ...genesis, forks: { signatureDomain: { activationHeight: 1 } } }
        expect(freshGenesisProblems({ ...ok, genesisData: edited })).toHaveLength(1)
    })

    it("refuses another snapshot, or none", () => {
        expect(
            freshGenesisProblems({ ...ok, snapshotManifestHash: "c".repeat(64) }).join(),
        ).toContain("snapshot manifest hashes to")
        expect(
            freshGenesisProblems({ ...ok, snapshotManifestHash: null }).join(),
        ).toContain("no snapshot manifest")
    })

    it("checks a declared snapshot even without a pin", () => {
        expect(
            freshGenesisProblems({ ...ok, pin: "", snapshotManifestHash: "c".repeat(64) }),
        ).toHaveLength(1)
    })

    it("refuses RESTORE, a missing timestamp, and an unbound snapshot", () => {
        expect(freshGenesisProblems({ ...ok, restore: true }).join()).toContain("RESTORE")

        const { timestamp: _t, ...noTimestamp } = genesis
        const noTs = freshGenesisProblems({
            ...ok,
            genesisData: noTimestamp,
            pin: hashGenesisData(noTimestamp),
        })
        expect(noTs.join()).toContain("no timestamp")

        const { snapshot: _s, ...unbound } = genesis
        const noDecl = freshGenesisProblems({
            ...ok,
            genesisData: unbound,
            pin: hashGenesisData(unbound),
        })
        expect(noDecl.join()).toContain("does not declare snapshot.manifestSha256")
    })

    it("leaves an unpinned genesis without a snapshot declaration alone", () => {
        const { snapshot: _s, ...unbound } = genesis
        expect(
            freshGenesisProblems({ ...ok, genesisData: unbound, pin: "", restore: true }),
        ).toEqual([])
    })

    it("refuses a malformed snapshot declaration", () => {
        expect(() => declaredManifestHash({ snapshot: { manifestSha256: "x" } })).toThrow(
            GenesisRefusal,
        )
        expect(declaredManifestHash({})).toBeNull()
    })
})

describe("restartGenesisProblems", () => {
    const stored = launchGenesis()
    const pin = hashGenesisData(stored)

    it("passes the same files", () => {
        expect(
            restartGenesisProblems({ storedGenesisData: stored, fileGenesisData: stored, pin }),
        ).toEqual([])
    })

    it("allows a schedule edit in the file; the schedule check decides on it", () => {
        const file = { ...stored, forks: { ...stored.forks, editBinding: { activationHeight: 900 } } }
        expect(
            restartGenesisProblems({ storedGenesisData: stored, fileGenesisData: file, pin }),
        ).toEqual([])
    })

    it("refuses a database from another chain", () => {
        const problems = restartGenesisProblems({
            storedGenesisData: stored,
            fileGenesisData: stored,
            pin: "ab".repeat(32),
        })
        expect(problems.join()).toContain("belongs to another chain")
    })

    it("refuses a file that differs from block 0 beyond the schedule", () => {
        const file = { ...stored, timestamp: "1" }
        expect(
            restartGenesisProblems({ storedGenesisData: stored, fileGenesisData: file, pin }).join(),
        ).toContain("more than the fork schedule")
    })

    it("refuses a chain id change with or without a pin", () => {
        const file = { ...stored, properties: { ...stored.properties, id: 8 } }
        expect(
            restartGenesisProblems({ storedGenesisData: stored, fileGenesisData: file, pin: "" }).join(),
        ).toContain("chain id 8")
    })
})

describe("parseStoredGenesisData", () => {
    it("reads the JSON string block 0 stores, also when encoded twice", () => {
        const data = { a: 1 }
        expect(parseStoredGenesisData(JSON.stringify(data))).toEqual(data)
        expect(parseStoredGenesisData(JSON.stringify(JSON.stringify(data)))).toEqual(data)
    })
})
