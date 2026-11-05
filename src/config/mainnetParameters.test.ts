import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { DEFAULT_CONFIG } from "./defaults"
import { EnvKey } from "./envKeys"
import { DEFAULT_BLOCK_TIME } from "../utilities/constants"

// The mainnet parameter sheet, the node's built-in values and the compose file
// must not drift: an operator who copies the sheet and one who leaves a value
// unset must still run the same chain, and a sheet key compose does not pass
// never reaches the container.
const repo = path.resolve(import.meta.dir, "../..")

function readSheet(): Record<string, string> {
    const values: Record<string, string> = {}
    const text = fs.readFileSync(path.join(repo, "docs/mainnet/parameters.env"), "utf8")
    for (const line of text.split("\n")) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
        if (m) values[m[1]] = m[2].trim()
    }
    return values
}

function composeNodeService(): string {
    const yml = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8")
    const start = yml.indexOf("\n  node:\n")
    const end = yml.indexOf("\n  reaper:\n")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return yml.slice(start, end)
}

const sheet = readSheet()
const core = DEFAULT_CONFIG.core

describe("mainnet parameter sheet", () => {
    it("names only settings the node reads", () => {
        const known = new Set<string>(Object.values(EnvKey))
        for (const key of Object.keys(sheet)) {
            expect([key, known.has(key)]).toEqual([key, true])
        }
    })

    it("is passed to the node container by docker-compose.yml", () => {
        const node = composeNodeService()
        for (const key of Object.keys(sheet)) {
            const listed = new RegExp(`^\\s+${key}: \\$\\{${key}:-`, "m").test(node)
            expect([key, listed]).toEqual([key, true])
        }
    })

    it("equals the node's built-in chain values", () => {
        expect(sheet).toMatchObject({
            CONSENSUS_TIME: String(core.consensusTime || DEFAULT_BLOCK_TIME),
            BLOCK_TIMESTAMP_MIN_DELTA: String(core.blockTimestampMinDelta),
            BLOCK_TIMESTAMP_TOLERANCE: String(core.blockTimestampTolerance),
            NETWORK_FEE: String(core.networkFee),
            RPC_FEE: String(core.rpcFee),
            BURN_FEE: String(core.burnFee),
            RPC_FEE_PERCENT: String(core.rpcFeePercent),
            MIN_VALIDATOR_STAKE: core.minValidatorStake,
            ZK_ATTESTATION_POINTS: String(DEFAULT_CONFIG.identity.zkAttestationPoints),
            FORK_SCHEDULE_MISMATCH_POLICY: core.forkScheduleMismatchPolicy,
        })
    })

    it("runs validators in production mode with an on-chain validator set", () => {
        expect(sheet.PROD).toBe("true")
        expect(sheet.DEMOS_REQUIRE_VALIDATORS).toBe("true")
    })
})
