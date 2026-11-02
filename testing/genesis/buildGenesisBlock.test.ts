/**
 * Block 0 as built without a database (src/libs/blockchain/genesis/buildGenesisBlock.ts),
 * the hash scripts/genesis-hash.ts publishes as EXPECTED_GENESIS_BLOCK_HASH.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { loadForkConfigFromGenesis } from "src/forks"
import { buildGenesisBlock } from "src/libs/blockchain/genesis/buildGenesisBlock"
import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"

function launchGenesis(): Record<string, any> {
    const data = JSON.parse(readFileSync("data/genesis.json", "utf8"))
    return { ...data, timestamp: 1793318400 }
}

describe("buildGenesisBlock", () => {
    // Block 0 of a running chain can never change; a different value here means
    // nodes on this build would reject the chain they already hold.
    it("builds the block 0 this repository's genesis has always produced", () => {
        const genesis = launchGenesis()
        loadForkConfigFromGenesis(genesis)
        expect(buildGenesisBlock(genesis).genesisBlock.hash).toBe(
            "0cb7dac8af30ca2dfc0d6f40993acad5250d1b0d952043d9cf11312709d4dd0b",
        )
    })

    it("builds the same block 0 from the same file", () => {
        const genesis = launchGenesis()
        loadForkConfigFromGenesis(genesis)
        const a = buildGenesisBlock(genesis).genesisBlock.hash
        const b = buildGenesisBlock(JSON.parse(JSON.stringify(genesis))).genesisBlock.hash
        expect(a).toMatch(/^[0-9a-f]{64}$/)
        expect(b).toBe(a)
    })

    it("changes block 0 but not the data hash when the file orders its keys differently", () => {
        const genesis = launchGenesis()
        loadForkConfigFromGenesis(genesis)
        const reordered = Object.fromEntries(Object.entries(genesis).reverse())
        expect(hashGenesisData(reordered)).toBe(hashGenesisData(genesis))
        expect(buildGenesisBlock(reordered).genesisBlock.hash).not.toBe(
            buildGenesisBlock(genesis).genesisBlock.hash,
        )
    })

    it("commits to the genesis timestamp", () => {
        const genesis = launchGenesis()
        loadForkConfigFromGenesis(genesis)
        const later = { ...genesis, timestamp: genesis.timestamp + 1 }
        expect(buildGenesisBlock(later).genesisBlock.hash).not.toBe(
            buildGenesisBlock(genesis).genesisBlock.hash,
        )
    })
})
