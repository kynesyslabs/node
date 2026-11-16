import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { EnvKey } from "./envKeys"

// Identity verification calls these providers; a key the compose file does
// not pass never reaches the container, and that verification fails there
// while it works outside docker.
const PROVIDER_KEYS = [
    EnvKey.RAPID_API_KEY,
    EnvKey.RAPID_API_HOST,
    EnvKey.GITHUB_TOKEN,
    EnvKey.DISCORD_BOT_TOKEN,
    EnvKey.HUMAN_PASSPORT_API_KEY,
    EnvKey.NOMIS_API_KEY,
    EnvKey.NOMIS_CLIENT_ID,
    EnvKey.ETHERSCAN_API_KEY,
    EnvKey.HELIUS_API_KEY,
    EnvKey.SOLANA_RPC,
]

const repo = path.resolve(import.meta.dir, "../..")

function composeNodeService(): string {
    const yml = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8")
    const start = yml.indexOf("\n  node:\n")
    const end = yml.indexOf("\n  reaper:\n")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return yml.slice(start, end)
}

describe("identity provider settings in docker-compose.yml", () => {
    it("are passed to the node container", () => {
        const node = composeNodeService()
        for (const key of PROVIDER_KEYS) {
            const listed = new RegExp(`^\\s+${key}: \\$\\{${key}:-`, "m").test(node)
            expect([key, listed]).toEqual([key, true])
        }
    })
})

describe("the admin RPC key in docker-compose.yml", () => {
    // The node answers its admin RPC only to SUDO_PUBKEY; a key the compose
    // file does not pass leaves the admin RPC closed inside the container.
    it("is passed to the node container", () => {
        expect(composeNodeService()).toMatch(
            new RegExp(`^\\s+${EnvKey.SUDO_PUBKEY}: \\$\\{${EnvKey.SUDO_PUBKEY}:-\\}$`, "m"),
        )
    })

    it("is listed in .env.example", () => {
        const example = fs.readFileSync(path.join(repo, ".env.example"), "utf8")
        expect(example).toMatch(/^SUDO_PUBKEY=$/m)
    })
})
