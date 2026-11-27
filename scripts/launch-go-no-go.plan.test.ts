/**
 * The mainnet genesis template and the launch validator table rules
 * (--plan): what can be checked before any validator is up.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    KNOWN_FORKS,
    LAUNCH_DORMANT_FORKS,
    LAUNCH_SHARD_SIZE,
    MAINNET_CHAIN_ID,
    MAINNET_FORKS,
    NON_MAINNET_CHAIN_IDS,
    REFUSED_MAINNET_CHAIN_IDS,
    launchGenesisExpectations,
    launchPlanChecks,
    mainnetGenesisReasons,
    validatorTable,
} from "./launch-go-no-go"
import { notaryKeyHex, tlsnVerifiedPayload } from "src/libs/blockchain/testSupport/tlsnVerifiedFixtures"
import { NFT_ALLOWLIST_PATH } from "src/features/staking/nftAllowlist"

const ROOT = join(import.meta.dir, "..")
const TEMPLATE = join(ROOT, "docs/mainnet/genesis.template.json")
const readTemplate = () => JSON.parse(readFileSync(TEMPLATE, "utf8"))
const id = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")
const MINTS: string[] = JSON.parse(readFileSync(NFT_ALLOWLIST_PATH, "utf8")).mints
const NFT_OWNER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const PROOF_TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
const isFill = (v: unknown) => typeof v === "string" && v.startsWith("FILL")
const TREASURY = "0x" + "ab".repeat(32)
/** The notary keys tlsnVerifiedPayload() lists, as --expected-notary-keys names them. */
const NOTARY_KEYS = `demos-notary-1:${notaryKeyHex(0x11)},demos-notary-standby:${notaryKeyHex(0x22)}`

/** The template with every FILL field given a value, as the owners would. */
function filledTemplate(validators = 10) {
    const g = readTemplate()
    g.properties.name = "DEMOS-MAINNET-TEST"
    g.properties.currency = "DEM"
    delete g.properties.sudoPubkey
    g.forks.gasFeeSeparation = { activationHeight: 0, treasuryAddress: TREASURY }
    g.forks.tlsnVerified = { ...g.forks.tlsnVerified, ...tlsnVerifiedPayload() }
    delete g.snapshot
    g.balances = []
    g.timestamp = "1793318400"
    g.validators = Array.from({ length: validators }, (_, i) => ({
        address: id(i),
        status: "2",
        connection_url: `http://v${i}.example:53550`,
        staked_amount: "0",
        first_seen: 0,
        valid_at: 0,
        nft_mint: MINTS[i],
        nft_owner: NFT_OWNER,
        nft_proof_tx: PROOF_TX,
    })) as Array<Record<string, unknown>>
    return g
}

const blockZero = (n: number) => ({
    rows: Array.from({ length: n }, (_, i) => ({ address: id(i), status: "2", valid_at: 0 })),
    source: "genesis" as const,
    reasons: [],
    warnings: [],
})

/** n validators, at most three per owner, operator and provider, each with a region. */
function table(n: number, edit: (i: number) => Record<string, string> = () => ({})) {
    return Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
            id(i),
            { owner: `owner-${i % 4}`, operator: `op-${i % 4}`, provider: `cloud-${i % 4}`, region: `region-${i % 4}`, ...edit(i) },
        ]),
    )
}

const failing = (checks: ReturnType<typeof launchPlanChecks>) => checks.filter(c => !c.ok).map(c => c.name)

describe("mainnet genesis template", () => {
    it("opens seats by NFT only at block 0 and leaves governance off", () => {
        const forks = readTemplate().forks
        expect(forks.nftValidatorGating.activationHeight).toBe(0)
        expect(forks.tokenStaking.activationHeight).toBe(0)
        expect(forks.tokenStakingGate.activationHeight).toBe(0)
        expect(forks.networkGovernance.activationHeight).toBeNull()
    })

    it("schedules every mainnet fork at block 0", () => {
        const forks = readTemplate().forks
        for (const name of MAINNET_FORKS) {
            expect(forks[name].activationHeight).toBe(0)
            // Only gasFeeSeparation and tlsnVerified carry a payload: the
            // treasury, and the notary keys and verifier pin
            const payload = Object.keys(forks[name]).filter(k => k !== "activationHeight")
            if (name === "gasFeeSeparation") expect(payload).toEqual(["treasuryAddress"])
            else if (name === "tlsnVerified") {
                expect(payload.sort()).toEqual(
                    ["freshnessWindowSec", "futureSkewSec", "maxPresentationBytes", "notaryKeys", "verifierWasmSha256"],
                )
            } else expect(payload).toEqual([])
        }
    })

    it("declares every fork this build knows and no other", () => {
        expect(Object.keys(readTemplate().forks).sort()).toEqual([...KNOWN_FORKS].sort())
    })

    it("leaves the owners' decisions as FILL values the node refuses to load", async () => {
        const g = readTemplate()
        for (const v of [
            g.forks.gasFeeSeparation.treasuryAddress,
            ...g.forks.tlsnVerified.notaryKeys.map((k: { hex: string }) => k.hex),
            g.forks.tlsnVerified.verifierWasmSha256,
            g.balances,
            g.timestamp,
            g.validators,
        ]) {
            expect(isFill(v)).toBe(true)
        }
        await expect(launchGenesisExpectations(g)).rejects.toThrow()
    })

    it("pins no identity", () => {
        const text = readFileSync(TEMPLATE, "utf8")
        expect(text).not.toMatch(/0x[0-9a-f]{64}/)
    })

    it("carries the decided mainnet chain id, which is none of the refused ones", () => {
        expect(MAINNET_CHAIN_ID).toBe(8587492)
        expect(readTemplate().properties.id).toBe(MAINNET_CHAIN_ID)
        expect(REFUSED_MAINNET_CHAIN_IDS).not.toContain(MAINNET_CHAIN_ID)
        expect(mainnetGenesisReasons(filledTemplate()).filter(r => r.startsWith("genesis properties.id"))).toEqual([])
    })

    it("once filled, passes the genesis checks and loads as a node loads it", async () => {
        const g = filledTemplate()
        expect(mainnetGenesisReasons(g)).toEqual([])
        const e = await launchGenesisExpectations(g)
        expect(e.genesisFileProblems).toEqual([])
        expect(e.genesisFileBlockHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it("lists a primary and a standby notary key, secp256k1, for the ceremony to fill", () => {
        const keys = readTemplate().forks.tlsnVerified.notaryKeys
        expect(keys.map((k: { id: string }) => k.id)).toEqual(["demos-notary-1", "demos-notary-standby"])
        expect(keys.every((k: { alg: string }) => k.alg === "k256")).toBe(true)
    })

    it("refuses the template's placeholder notary keys, and passes once the ceremony keys are in", async () => {
        const g = filledTemplate()
        g.forks.tlsnVerified = readTemplate().forks.tlsnVerified
        const reasons = mainnetGenesisReasons(g).join("\n")
        expect(reasons).toContain("fork tlsnVerified is scheduled with placeholder or unset notary keys")
        expect(reasons).toContain("genesis.forks.tlsnVerified.notaryKeys[0].hex")
        await expect(launchGenesisExpectations(g)).rejects.toThrow("Genesis fork \"tlsnVerified\" is invalid")

        const filled = filledTemplate()
        expect(mainnetGenesisReasons(filled)).toEqual([])
        await expect(launchGenesisExpectations(filled)).resolves.toBeDefined()
    })

    it("shows unset notary keys on the genesis forks line of --plan", () => {
        const g = filledTemplate()
        g.forks.tlsnVerified = readTemplate().forks.tlsnVerified
        const checks = launchPlanChecks({ botAllowlist: [], genesis: g, blockZero: blockZero(10), shardSize: 10, operators: table(10), genesisFileProblems: [], expectedTreasury: TREASURY, expectedNotaryKeys: NOTARY_KEYS })
        expect(failing(checks)).toContain("genesis forks")
        expect(checks.find(c => c.name === "genesis forks")?.details.join("\n")).toContain("placeholder or unset notary keys")
    })

    it("refuses a placeholder treasury that block 0 would migrate, unless the snapshot carries the fork", async () => {
        const g = filledTemplate()
        g.forks.gasFeeSeparation = { activationHeight: null, treasuryAddress: "0x" + "0".repeat(64) }
        // The loader accepts the zero address on a null height
        expect((await launchGenesisExpectations(g)).genesisFileProblems).toEqual([])

        const fresh = await launchGenesisExpectations(g, null, [])
        expect(fresh.genesisFileProblems.join("\n")).toContain("treasuryAddress equals BURN_ADDRESS")

        const carried = await launchGenesisExpectations(g, null, [{ fork_name: "gasFeeSeparation", applied: true }])
        expect(carried.genesisFileProblems).toEqual([])
    })

    it("refuses an OS-unit snapshot under a genesis that activates osDenomination later", async () => {
        const g = filledTemplate()
        g.forks.osDenomination = { activationHeight: 100 }
        const e = await launchGenesisExpectations(g, null, [{ fork_name: "osDenomination", applied: true }])
        expect(e.genesisFileProblems.join("\n")).toContain("the snapshot is already in OS units")
    })

    it("lists the same mainnet forks as the genesis acceptance harness", () => {
        const sh = readFileSync(join(ROOT, "testing/genesis-acceptance/run.sh"), "utf8")
        const py = readFileSync(join(ROOT, "testing/genesis-acceptance/fixtures.py"), "utf8")
        const fromSh = /^MAINNET_FORKS="([^"]*)"/m.exec(sh)?.[1].split(/\s+/)
        const fromPy = /^MAINNET_FORKS = \[([^\]]*)\]/m.exec(py)?.[1].split(",").map(s => s.trim().replace(/"/g, ""))
        expect(fromSh).toEqual([...MAINNET_FORKS])
        expect(fromPy).toEqual([...MAINNET_FORKS])
        // The harness's launch genesis must declare every fork, or the node
        // refuses it on the mainnet-shaped chain id
        const knownPy = /^KNOWN_FORKS = \[([^\]]*)\]/m.exec(py)?.[1].split(",").map(s => s.trim().replace(/"/g, ""))
        expect(knownPy).toEqual([...KNOWN_FORKS])
        const dormantPy = /^LAUNCH_DORMANT_FORKS = \[([^\]]*)\]/m.exec(py)?.[1].split(",").map(s => s.trim().replace(/"/g, ""))
        expect(dormantPy).toEqual([...LAUNCH_DORMANT_FORKS])
    })
})

describe("mainnetGenesisReasons", () => {
    it("refuses template FILL values left anywhere in the file", () => {
        const g = filledTemplate()
        g.properties.name = "FILL: network name (testnet: DEMOS)"
        g.properties.currency = "FILL: currency symbol (testnet: DEM)"
        const reasons = mainnetGenesisReasons(g).join("\n")
        expect(reasons).toContain("genesis.properties.name")
        expect(reasons).toContain("genesis.properties.currency")
        expect(mainnetGenesisReasons(readTemplate()).join("\n")).toContain("template FILL values")
    })

    it("ignores nft_exempt while NFT validator gating is unscheduled, which is NO-GO itself", () => {
        const g = filledTemplate()
        g.forks.nftValidatorGating = { activationHeight: null }
        g.validators[2].nft_exempt = true
        const reasons = mainnetGenesisReasons(g).join("\n")
        expect(reasons).not.toContain("nft_exempt")
        expect(reasons).toContain("fork nftValidatorGating is not scheduled at activationHeight 0")
    })

    it("refuses a validator without its NFT fields, and passes once each seat names one", () => {
        const g = filledTemplate()
        expect(mainnetGenesisReasons(g)).toEqual([])
        delete g.validators[4].nft_proof_tx
        g.validators[6].nft_mint = g.validators[1].nft_mint
        const reasons = mainnetGenesisReasons(g).join("\n")
        expect(reasons).toContain(`genesis.validators[4] (${id(4)}): nft_proof_tx must be a base58 string`)
        expect(reasons).toContain(`genesis.validators[6] (${id(6)}): nft_mint ${MINTS[1]} already backs ${id(1)}`)
    })

    it("refuses a validator seated without an NFT", () => {
        const g = filledTemplate()
        g.forks.nftValidatorGating = { activationHeight: 0 }
        g.validators[2].nft_exempt = true
        g.validators[5].nft_exempt = true
        const reasons = mainnetGenesisReasons(g).join("\n")
        expect(reasons).toContain("2 genesis validators are nft_exempt")
        expect(reasons).toContain(id(2))
        expect(reasons).toContain(id(5))
        g.validators[2].nft_exempt = false
        delete g.validators[5].nft_exempt
        expect(mainnetGenesisReasons(g).join("\n")).not.toContain("nft_exempt")
    })

    it("refuses the testnet and devnet chain ids, and a missing one", () => {
        for (const chainId of NON_MAINNET_CHAIN_IDS) {
            const g = filledTemplate()
            g.properties.id = chainId
            expect(mainnetGenesisReasons(g).join("\n")).toContain(`properties.id ${chainId} is the chain id of the testnet`)
        }
        const g = filledTemplate()
        delete g.properties.id
        expect(mainnetGenesisReasons(g).join("\n")).toContain("must be the agreed mainnet chain id")
    })

    it("refuses 0 and 31337 as reserved chain ids", () => {
        for (const chainId of [0, 31337]) {
            const g = filledTemplate()
            g.properties.id = chainId
            expect(mainnetGenesisReasons(g).join("\n")).toContain(`properties.id ${chainId} is reserved`)
        }
    })

    it("refuses each of 0, 1, 1337 and 31337, and the plan check fails on it", () => {
        expect([...REFUSED_MAINNET_CHAIN_IDS].sort((a, b) => a - b)).toEqual([0, 1, 1337, 31337])
        for (const chainId of REFUSED_MAINNET_CHAIN_IDS) {
            const g = filledTemplate()
            g.properties.id = chainId
            const checks = launchPlanChecks({ botAllowlist: [], genesis: g, blockZero: blockZero(10), shardSize: 10, operators: table(10), genesisFileProblems: [], expectedTreasury: TREASURY, expectedNotaryKeys: NOTARY_KEYS })
            expect(failing(checks)).toEqual(["chain id"])
        }
    })

    it(`refuses a shardSize other than ${LAUNCH_SHARD_SIZE}`, () => {
        for (const shardSize of [4, 13, "10"]) {
            const g = filledTemplate()
            g.properties.shardSize = shardSize
            expect(mainnetGenesisReasons(g).join("\n")).toContain(`the launch committee size is ${LAUNCH_SHARD_SIZE}`)
        }
    })

    it("refuses a fork left undeclared, since it would take the code default", () => {
        for (const name of KNOWN_FORKS) {
            const g = filledTemplate()
            delete g.forks[name]
            expect(mainnetGenesisReasons(g).join("\n")).toContain(`the genesis does not declare ${name}`)
        }
    })

    it("refuses a scheduled gasFeeSeparation without its own treasury", () => {
        const g = filledTemplate()
        g.forks.gasFeeSeparation = { activationHeight: 0 }
        expect(mainnetGenesisReasons(g).join("\n")).toContain("without a treasuryAddress")
    })

    it("refuses a scheduled gasFeeSeparation whose treasury the node would refuse", () => {
        for (const [treasuryAddress, why] of [
            ["0x" + "AB".repeat(32), "must match"],
            ["0x" + "ab".repeat(31), "must match"],
            ["ab".repeat(32), "must match"],
            ["0x" + "0".repeat(64), "equals BURN_ADDRESS"],
        ]) {
            const g = filledTemplate()
            g.forks.gasFeeSeparation = { activationHeight: 0, treasuryAddress }
            const reasons = mainnetGenesisReasons(g).join("\n")
            expect(reasons).toContain("scheduled with a treasuryAddress the node refuses")
            expect(reasons).toContain(why)
        }
        expect(mainnetGenesisReasons(filledTemplate()).join("\n")).not.toContain("treasuryAddress")
    })

    it("refuses a genesis that leaves gasFeeSeparation off, where a transfer pays a flat gas no account receives", () => {
        const g = filledTemplate()
        g.forks.gasFeeSeparation.activationHeight = null
        expect(mainnetGenesisReasons(g)).toEqual([
            "fork gasFeeSeparation is not scheduled at activationHeight 0 in the genesis (found null)",
        ])
    })
})

describe("validator table", () => {
    it("passes ten validators spread three or fewer per operator and provider", () => {
        const checks = launchPlanChecks({
            botAllowlist: [],
            genesis: filledTemplate(),
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10),
            genesisFileProblems: [],
            expectedTreasury: TREASURY,
            expectedNotaryKeys: NOTARY_KEYS,
        })
        expect(failing(checks)).toEqual([])
    })

    it("fails a genesis whose name and currency are still template FILL values", () => {
        const g = filledTemplate()
        g.properties.name = "FILL: network name (testnet: DEMOS)"
        g.properties.currency = "FILL: currency symbol (testnet: DEM)"
        const checks = launchPlanChecks({
            botAllowlist: [],
            genesis: g,
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10),
            genesisFileProblems: [],
            expectedTreasury: TREASURY,
            expectedNotaryKeys: NOTARY_KEYS,
        })
        expect(failing(checks)).toEqual(["genesis values"])
        const details = checks.find(c => c.name === "genesis values").details.join("\n")
        expect(details).toContain("genesis.properties.name")
        expect(details).toContain("genesis.properties.currency")
    })

    it("reports, without failing, four validators of one operator: over the spare seats and a third of the votes", () => {
        const checks = launchPlanChecks({
            botAllowlist: [],
            genesis: filledTemplate(),
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10, i => (i < 4 ? { operator: "big-op" } : { operator: `op-${i}` })),
            genesisFileProblems: [],
            expectedTreasury: TREASURY,
            expectedNotaryKeys: NOTARY_KEYS,
        })
        expect(failing(checks)).toEqual([])
        const note = checks.find(c => c.name === "owner and operator concentration")
        expect(note.advisory).toBe(true)
        expect(note.details.join("\n")).toContain(
            "operator big-op runs 4 of 10 launch validators, more than the 3 seats a committee can lose",
        )
        expect(note.details.join("\n")).toContain("operator big-op can hold 4 of the 10 first-committee votes")
    })

    it("fails four validators on one provider, whatever the spelling", () => {
        const spellings = ["AWS", "aws", " Aws ", "aws"]
        const checks = launchPlanChecks({
            botAllowlist: [],
            genesis: filledTemplate(),
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10, i => (i < 4 ? { provider: spellings[i] } : { provider: `cloud-${i}` })),
            genesisFileProblems: [],
            expectedTreasury: TREASURY,
            expectedNotaryKeys: NOTARY_KEYS,
        })
        expect(failing(checks)).toEqual(["provider cap", "voting power per provider"])
        expect(checks.find(c => c.name === "provider cap").details.join("\n")).toContain("provider aws runs 4 of 10")
    })

    it("fails a row without a region or without an entry", () => {
        const ops = table(10)
        delete (ops[id(2)] as Record<string, string>).region
        delete ops[id(3)]
        const checks = launchPlanChecks({ botAllowlist: [], genesis: filledTemplate(), blockZero: blockZero(10), shardSize: 10, operators: ops, genesisFileProblems: [], expectedTreasury: TREASURY, expectedNotaryKeys: NOTARY_KEYS })
        expect(failing(checks)).toEqual(["validator table"])
        const details = checks.find(c => c.name === "validator table").details.join("\n")
        expect(details).toContain(`have no region: ${id(2)}`)
        expect(details).toContain(`no operator/provider entry: ${id(3)}`)
    })

    it("fails fewer launch validators than the quorum", () => {
        const checks = launchPlanChecks({ botAllowlist: [], genesis: filledTemplate(6), blockZero: blockZero(6), shardSize: 10, operators: table(6), genesisFileProblems: [], expectedTreasury: TREASURY, expectedNotaryKeys: NOTARY_KEYS })
        expect(failing(checks)).toContain("launch validators")
    })

    it("reports each failed genesis rule on its own line", () => {
        const g = filledTemplate()
        g.properties.id = 1
        g.properties.shardSize = 4
        g.forks.commitLock = { activationHeight: null }
        const checks = launchPlanChecks({ botAllowlist: [], genesis: g, blockZero: blockZero(10), shardSize: 4, operators: table(10), genesisFileProblems: ["x"], expectedTreasury: TREASURY, expectedNotaryKeys: NOTARY_KEYS })
        expect(failing(checks)).toEqual(
            expect.arrayContaining(["genesis forks", "chain id", "shard size", "genesis file"]),
        )
    })

    it("fails the notary keys check without the agreed keys, or with others in the genesis", () => {
        const plan = (expectedNotaryKeys: string | null) =>
            launchPlanChecks({ botAllowlist: [], genesis: filledTemplate(), blockZero: blockZero(10), shardSize: 10, operators: table(10), genesisFileProblems: [], expectedTreasury: TREASURY, expectedNotaryKeys })
        const missing = plan(null)
        expect(failing(missing)).toEqual(["notary keys"])
        expect(missing.find(c => c.name === "notary keys").details.join("\n")).toContain("no --expected-notary-keys given")
        const wrong = plan(`demos-notary-1:${notaryKeyHex(0x11)},demos-notary-standby:${notaryKeyHex(0x33)}`)
        expect(failing(wrong)).toEqual(["notary keys"])
        expect(wrong.find(c => c.name === "notary keys").details.join("\n")).toContain("are not the agreed notary keys")
        expect(failing(plan(NOTARY_KEYS))).toEqual([])
    })

    it("fails the treasury check without the agreed treasury, or with another one in the genesis", () => {
        const plan = (expectedTreasury: string | null, g = filledTemplate()) =>
            launchPlanChecks({ botAllowlist: [], genesis: g, blockZero: blockZero(10), shardSize: 10, operators: table(10), genesisFileProblems: [], expectedTreasury, expectedNotaryKeys: NOTARY_KEYS })
        const missing = plan(null)
        expect(failing(missing)).toEqual(["treasury"])
        expect(missing.find(c => c.name === "treasury").details.join("\n")).toContain("no --expected-treasury given")
        const other = "0x" + "cd".repeat(32)
        const wrong = plan(other)
        expect(failing(wrong)).toEqual(["treasury"])
        expect(wrong.find(c => c.name === "treasury").details.join("\n")).toContain(
            `treasuryAddress ${TREASURY} is not the agreed treasury ${other}`,
        )
        expect(failing(plan(TREASURY.toUpperCase().replace("0X", "0x")))).toEqual([])
    })

    it("only warns about a missing region at T-0, where the table was already checked", () => {
        const ops = table(10)
        delete (ops[id(0)] as Record<string, string>).region
        const t = validatorTable(Array.from({ length: 10 }, (_, i) => id(i)), ops, 10)
        expect(t.reasons).toEqual([])
        expect(t.warnings.join("\n")).toContain("no region")
    })
})

/** Block 0 with a stake per validator, as the snapshot's validators.jsonl carries it. */
const stakedBlockZero = (stakes: string[]) => ({
    rows: stakes.map((staked_amount, i) => ({ address: id(i), status: "2", valid_at: 0, staked_amount })),
    source: "genesis" as const,
    reasons: [],
    warnings: [],
})

describe("validator concentration", () => {
    const plan = (operators: Record<string, unknown>, overrides: Partial<Parameters<typeof launchPlanChecks>[0]> = {}) =>
        launchPlanChecks({
            botAllowlist: [],
            genesis: filledTemplate(),
            blockZero: blockZero(10),
            shardSize: 10,
            operators,
            genesisFileProblems: [],
            expectedTreasury: TREASURY,
            expectedNotaryKeys: NOTARY_KEYS,
            ...overrides,
        })

    const concentration = (checks: ReturnType<typeof launchPlanChecks>) =>
        checks.find(c => c.name === "owner and operator concentration").details.join("\n")

    it("reports one owner behind four validators run by four operators on four providers, and passes", () => {
        // Every operator and provider is under its cap: only the owner shows the four seats
        const checks = plan(table(10, i => (i < 4 ? { owner: "buyer", operator: `hired-${i}`, provider: `host-${i}` } : { owner: `owner-${i}` })))
        expect(failing(checks)).toEqual([])
        expect(concentration(checks)).toContain(
            "owner buyer runs 4 of 10 launch validators, more than the 3 seats a committee can lose",
        )
        expect(concentration(checks)).toContain("owner buyer can hold 4 of the 10 first-committee votes")
    })

    it("reports nothing for three validators per owner, the seats a committee of ten can lose", () => {
        const checks = plan(table(10, i => (i < 3 ? { owner: "buyer", operator: `hired-${i}` } : {})))
        expect(failing(checks)).toEqual([])
        expect(concentration(checks)).toBe("")
    })

    it("counts the owner over the whole launch set, since any of its validators may be drawn", () => {
        const g = filledTemplate(40)
        const ops = Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [
                id(i),
                { owner: i < 4 ? "buyer" : `owner-${i}`, operator: `op-${i}`, provider: `cloud-${i}`, region: `region-${i % 8}` },
            ]),
        )
        const checks = plan(ops, { genesis: g, blockZero: blockZero(40) })
        expect(failing(checks)).toEqual([])
        expect(concentration(checks)).toContain("owner buyer runs 4 of 40")
    })

    it("compares owner names without regard to case or surrounding spaces", () => {
        const spellings = ["Buyer", "buyer", " BUYER ", "buyer"]
        const checks = plan(table(10, i => (i < 4 ? { owner: spellings[i], operator: `hired-${i}`, provider: `host-${i}` } : { owner: `owner-${i}` })))
        expect(concentration(checks)).toContain("owner buyer runs 4 of 10")
    })

    it("notes a launch validator without an owner on the mainnet chain id, without failing", () => {
        const ops = table(10)
        delete (ops[id(5)] as Record<string, string>).owner
        const checks = plan(ops)
        expect(failing(checks)).toEqual([])
        expect(concentration(checks)).toContain(
            `1 launch validators have no owner in the operator map, so their owner concentration cannot be reported: ${id(5)}`,
        )
    })

    it("does not require an owner on the testnet or a devnet chain id", () => {
        const g = filledTemplate()
        g.properties.id = NON_MAINNET_CHAIN_IDS[0]
        const ops = Object.fromEntries(Object.entries(table(10)).map(([k, v]) => [k, { ...v, owner: undefined }]))
        expect(concentration(plan(ops, { genesis: g }))).not.toContain("no owner")
    })

    it("fails a region hosting a third of the launch validators, and passes one below a third", () => {
        const fourOfTen = plan(table(10, i => ({ region: i < 4 ? "eu-central" : `region-${i}` })))
        expect(failing(fourOfTen)).toEqual(["region share"])
        expect(fourOfTen.find(c => c.name === "region share").details.join("\n")).toContain(
            "region eu-central hosts 4 of 10 launch validators, a third or more of the set",
        )
        expect(failing(plan(table(10, i => ({ region: i < 3 ? "eu-central" : `region-${i}` }))))).toEqual([])
        // 3 of 9 is exactly a third
        const g = filledTemplate(9)
        const nine = Object.fromEntries(
            Array.from({ length: 9 }, (_, i) => [
                id(i),
                { owner: `owner-${i}`, operator: `op-${i}`, provider: `cloud-${i}`, region: i < 3 ? "eu-central" : `region-${i}` },
            ]),
        )
        expect(failing(plan(nine, { genesis: g, blockZero: blockZero(9) }))).toEqual(["region share"])
    })

    it("reports, without failing, an owner holding a third of block 0's stake", () => {
        // Three validators pass the seat cap; their stake is what governance would weigh
        const stakes = Array.from({ length: 10 }, (_, i) => (i < 3 ? "3000" : "1000"))
        const ops = table(10, i => (i < 3 ? { owner: "whale", operator: `hired-${i}`, provider: `host-${i}` } : { owner: `owner-${i}` }))
        const checks = plan(ops, { blockZero: stakedBlockZero(stakes) })
        expect(failing(checks)).toEqual([])
        expect(concentration(checks)).toContain("owner whale holds 9000 of the 16000 block 0 stake (56.25%), a third or more")
    })

    it("fails a provider or region at exactly a third of the stake", () => {
        const stakes = ["1000", "1000", ...Array.from({ length: 8 }, () => "500")]
        const checks = plan(table(10, i => (i < 2 ? { region: "us-east" } : { region: `region-${i}` })), {
            blockZero: stakedBlockZero(stakes),
        })
        expect(failing(checks)).toEqual(["stake share"])
        expect(checks.find(c => c.name === "stake share").details.join("\n")).toContain(
            "region us-east holds 2000 of the 6000 block 0 stake (33.33%), a third or more",
        )
        expect(failing(plan(table(10), { blockZero: stakedBlockZero(Array.from({ length: 10 }, () => "1000")) }))).toEqual([])
    })

    it("fails a stake that is not a decimal integer", () => {
        const stakes = Array.from({ length: 10 }, (_, i) => (i === 0 ? "1e18" : "1000"))
        const checks = plan(table(10), { blockZero: stakedBlockZero(stakes) })
        expect(failing(checks)).toEqual(["stake share"])
        expect(checks.find(c => c.name === "stake share").details.join("\n")).toContain(`${id(0)} has staked_amount "1e18"`)
    })
})

describe("command line --plan", () => {
    const run = (args: string[]) => {
        const r = Bun.spawnSync(["bun", "scripts/launch-go-no-go.ts", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
    }

    it("needs the snapshot and the operator table", () => {
        const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
        const { tmpdir } = require("node:os") as typeof import("node:os")
        const file = join(mkdtempSync(join(tmpdir(), "go-no-go-plan-")), "genesis.json")
        writeFileSync(file, JSON.stringify(filledTemplate()))
        const r = run(["--plan", "--genesis", file])
        expect(r.code).toBe(2)
        expect(r.err).toContain("--plan needs --genesis, --snapshot and --operators")
    }, 60_000)
})
