/**
 * Block 0 through verifyBlock with the node's real builder, serializer and
 * hashing. A node builds block 0 with buildGenesisBlock, stores it in the
 * `json` content column of `blocks` (TypeORM writes JSON.stringify, the
 * driver reads back JSON.parse) and serves that row to syncing peers as JSON,
 * so the block a peer verifies is the built block through JSON. Only chain
 * storage is stubbed.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

let storedGenesisHash: string | null = null

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getGenesisBlockHash: async () => storedGenesisHash,
    },
}))

const { verifyBlock } = await import("./verifyBlock")
const { buildGenesisBlock } = await import(
    "src/libs/blockchain/genesis/buildGenesisBlock"
)
const { loadForkConfigFromGenesis } = await import("src/forks")

const REPO = join(import.meta.dir, "../../../..")

function readGenesis(file: string): any {
    return JSON.parse(readFileSync(join(REPO, file), "utf8"))
}

const hex = (byte: string) => byte.repeat(32)

/**
 * docs/mainnet/genesis.template.json with every "FILL: ..." placeholder
 * given a value of the form it asks for, as an operator fills it for launch.
 */
function filledMainnetTemplate(): any {
    const fills: Record<string, unknown> = {
        name: "DEMOS",
        currency: "DEM",
        sudoPubkey: `0x${hex("1a")}`,
        treasuryAddress: `0x${hex("2b")}`,
        verifierWasmSha256: hex("3c"),
        manifestSha256: hex("4d"),
        balances: [[`0x${hex("5e")}`, "1000000000"]],
        timestamp: "1793318400",
        validators: [
            {
                address: `0x${hex("6f")}`,
                status: "2",
                connection_url: "https://validator-1.example:53550",
                staked_amount: "1000000000000",
                first_seen: 0,
                valid_at: 0,
            },
        ],
    }
    // Compressed secp256k1 points G and 2G: the primary and standby notary
    const notaryKeys = [
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
    ]
    const fill = (value: unknown, key: string): unknown => {
        if (typeof value === "string" && value.startsWith("FILL")) {
            if (key === "hex") return notaryKeys.shift()
            if (!(key in fills)) throw new Error(`no fill for ${key}`)
            return fills[key]
        }
        if (Array.isArray(value)) return value.map(v => fill(v, key))
        if (value && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value).map(([k, v]) => [k, fill(v, k)]),
            )
        }
        return value
    }
    return fill(readGenesis("docs/mainnet/genesis.template.json"), "")
}

/** Block 0 built from `genesis`, as its stored row reaches a syncing peer. */
function storedGenesisOf(genesis: any): any {
    loadForkConfigFromGenesis(genesis)
    const { genesisBlock } = buildGenesisBlock(genesis)
    return JSON.parse(JSON.stringify(genesisBlock))
}

const GENESIS_FILES: [string, () => any][] = [
    [
        "testing/genesis/fixtures/block0-genesis.json",
        () => readGenesis("testing/genesis/fixtures/block0-genesis.json"),
    ],
    ["data/genesis.json", () => readGenesis("data/genesis.json")],
    ["docs/mainnet/genesis.template.json, filled", filledMainnetTemplate],
]

beforeEach(() => {
    storedGenesisHash = null
})

describe("verifyBlock on block 0 with real hashing", () => {
    for (const [name, genesisOf] of GENESIS_FILES) {
        it(`accepts the stored genesis built from ${name}`, async () => {
            const block = storedGenesisOf(genesisOf())
            expect(block.hash).toMatch(/^[0-9a-f]{64}$/)

            storedGenesisHash = block.hash
            expect(await verifyBlock(block)).toEqual({ valid: true })
        })

        it(`accepts the genesis built from ${name} before any genesis is stored`, async () => {
            const block = storedGenesisOf(genesisOf())
            expect(await verifyBlock(block)).toEqual({ valid: true })
        })
    }

    it("keeps the block 0 hash the launch fixture has always produced", () => {
        const block = storedGenesisOf(
            readGenesis("testing/genesis/fixtures/block0-genesis.json"),
        )
        expect(block.hash).toBe(
            "0cb7dac8af30ca2dfc0d6f40993acad5250d1b0d952043d9cf11312709d4dd0b",
        )
    })

    it("rejects a block 0 that carries the stored genesis hash over other genesis data", async () => {
        const genesis = readGenesis("testing/genesis/fixtures/block0-genesis.json")
        const stored = storedGenesisOf(genesis)
        storedGenesisHash = stored.hash

        const other = storedGenesisOf({
            ...genesis,
            balances: [[`0x${hex("99")}`, "1000000000000000"]],
        })
        const forged = { ...other, hash: stored.hash }

        const result = await verifyBlock(forged)
        expect(result.valid).toBe(false)
        expect(result.reason).toStartWith(
            `block hash mismatch: claimed ${stored.hash}, recomputed `,
        )
    })

    it("rejects a block 0 whose content was edited after hashing, with no genesis stored", async () => {
        const block = storedGenesisOf(
            readGenesis("testing/genesis/fixtures/block0-genesis.json"),
        )
        block.content.timestamp += 1

        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toStartWith(
            `block hash mismatch: claimed ${block.hash}, recomputed `,
        )
    })
})
