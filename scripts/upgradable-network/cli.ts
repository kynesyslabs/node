#!/usr/bin/env tsx
/**
 * Manual testing helper for the upgradable_network track (staking + governance).
 *
 * Usage:
 *   tsx scripts/manual_test_upgradable_network.ts <command> [args]
 *
 * Env:
 *   RPC_URL       default http://localhost:53550
 *   MNEMONIC_FILE default .manual-test-mnemonic  (auto-created on first `new-wallet`)
 *
 * See the "Manual testing walkthrough" section in
 * planning/UPGRADABLE_NETWORK_README.md for the recommended sequence.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import * as bip39 from "bip39"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"

const RPC_URL = process.env.RPC_URL ?? "http://localhost:53550"
const MNEMONIC_FILE = process.env.MNEMONIC_FILE ?? ".manual-test-mnemonic"

function exitWith(msg: string, code = 1): never {
    console.error(msg)
    process.exit(code)
}

function loadMnemonic(file = MNEMONIC_FILE): string {
    if (!existsSync(file)) {
        exitWith(
            `Mnemonic file ${file} not found. Run \`new-wallet\` first or set MNEMONIC_FILE to a valid path.`,
        )
    }
    return readFileSync(file, "utf8").trim()
}

async function connect(mnemonicFile?: string): Promise<Demos> {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    await demos.connectWallet(loadMnemonic(mnemonicFile))
    return demos
}

async function address(demos: Demos): Promise<string> {
    const addr = await demos.getEd25519Address()
    return addr.startsWith("0x") ? addr.slice(2) : addr
}

function pretty(v: unknown): string {
    return JSON.stringify(v, null, 2)
}

// ---------- commands ----------

async function cmdNewWallet(file?: string) {
    const target = file ?? MNEMONIC_FILE
    if (existsSync(target)) {
        exitWith(
            `Refusing to overwrite ${target}. Delete it first or pass a different file.`,
        )
    }
    const mnemonic = bip39.generateMnemonic(256)
    writeFileSync(target, mnemonic + "\n", { mode: 0o600 })
    const demos = new Demos()
    await demos.connectWallet(mnemonic)
    const addr = await demos.getEd25519Address()
    console.log(`✅ new wallet saved to ${target}`)
    console.log(`   address: ${addr}`)
    console.log(`   mnemonic: (written to ${target}, mode 0600 — never printed)`)
    console.log(
        "\n⚠️  Fund this address in the genesis before staking: it needs " +
            "at least DEFAULT_MIN_VALIDATOR_STAKE to register as a validator.",
    )
}

async function cmdStake(amount?: string, url?: string) {
    const demos = await connect()
    if (amount !== undefined) {
        try {
            if (BigInt(amount) <= 0n) {
                exitWith(`stake amount must be a positive integer: ${amount}`)
            }
        } catch {
            exitWith(`invalid stake amount: ${amount}`)
        }
    }
    const stakeAmount = amount ?? "1000000000000000000"
    // Reuse the configured RPC host so non-localhost devnets work.
    const connUrl = url ?? RPC_URL
    const addr = await address(demos)
    console.log(`staking ${stakeAmount} from ${addr} with url=${connUrl}`)
    const tx = await DemosTransactions.stake(stakeAmount, connUrl, demos)
    const validation = await demos.confirm(tx)
    const result = await demos.broadcast(validation)
    console.log(pretty(result))
}

async function cmdUnstake() {
    const demos = await connect()
    const tx = await DemosTransactions.unstake(demos)
    const validation = await demos.confirm(tx)
    const result = await demos.broadcast(validation)
    console.log(pretty(result))
}

async function cmdExit() {
    const demos = await connect()
    const tx = await DemosTransactions.validatorExit(demos)
    const validation = await demos.confirm(tx)
    const result = await demos.broadcast(validation)
    console.log(pretty(result))
}

async function cmdInfo(target?: string) {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    let addr = target
    if (!addr) {
        await demos.connectWallet(loadMnemonic())
        addr = await address(demos)
    }
    const info = await demos.getValidatorInfo(addr)
    if (!info) {
        console.log(`no validator record for ${addr}`)
        return
    }
    console.log(pretty(info))
}

async function cmdValidators(block?: string) {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    const n = block ? Number.parseInt(block, 10) : undefined
    const list = await demos.getValidators(n)
    console.log(`${list.length} validator(s)${n ? ` @ block ${n}` : ""}:`)
    console.log(pretty(list))
}

async function cmdStakedAmount(target?: string) {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    let addr = target
    if (!addr) {
        await demos.connectWallet(loadMnemonic())
        addr = await address(demos)
    }
    const amount = await demos.getStakedAmount(addr)
    console.log(amount)
}

async function cmdPropose(
    key: string,
    valueRaw: string,
    optEffectiveOffset?: string,
) {
    const demos = await connect()
    const currentBlock = await demos.getLastBlockNumber()
    // Voting window is 100, grace 50 → min offset is 150. Add headroom.
    const offset = optEffectiveOffset
        ? Number.parseInt(optEffectiveOffset, 10)
        : 160
    const effectiveAtBlock = currentBlock + offset

    const value = coerceValue(key, valueRaw)
    const proposalId = randomUUID()
    console.log(
        `proposing ${key}=${JSON.stringify(value)} at block ${effectiveAtBlock} (current=${currentBlock})`,
    )
    console.log(`proposalId: ${proposalId}`)

    const tx = await DemosTransactions.proposeNetworkUpgrade(
        {
            proposalId,
            proposedParameters: { [key]: value },
            rationale: `manual-test ${new Date().toISOString()}`,
            effectiveAtBlock,
        },
        demos,
    )
    const validation = await demos.confirm(tx)
    const result = await demos.broadcast(validation)
    console.log(pretty(result))
    // Only echo the proposalId-for-voting hint when the node actually accepted
    // the proposal. Otherwise the test scripts grep'd it as success spuriously.
    const ok =
        (result as { result?: number })?.result === 200 &&
        ((result as { response?: { message?: string } })?.response?.message ?
            !/error|reject|invalid|insufficient|locked|not an active|safety bounds|already/i.test(
                (result as { response: { message: string } }).response.message,
            )
            : true)
    if (ok) {
        console.log(`\n→ save this proposalId for voting: ${proposalId}`)
    } else {
        console.log(`\n✗ proposal NOT accepted: ${proposalId} (see response above)`)
        process.exitCode = 1
    }
}

function coerceValue(key: string, raw: string): unknown {
    if (key === "featureFlags") {
        return JSON.parse(raw)
    }
    // bigint params: validate before any other parse so an unrepresentable
    // value can't slip through Number().
    if (key === "minValidatorStake") {
        try {
            const big = BigInt(raw)
            if (big < 0n) exitWith(`${key} must be non-negative: ${raw}`)
        } catch {
            exitWith(`${key} must be a bigint string: ${raw}`)
        }
        return raw
    }
    // numeric bps / block values
    const n = Number(raw)
    if (!Number.isNaN(n) && /^-?\d+$/.test(raw) && Number.isSafeInteger(n)) {
        return n
    }
    if (/^\d{10,}$/.test(raw)) return raw
    return raw
}

async function cmdVote(proposalId: string, approveRaw: string) {
    if (!proposalId) exitWith("proposalId is required")
    if (approveRaw === undefined) exitWith("vote value is required (yes|no)")
    let approve: boolean
    if (/^(1|y|yes|true)$/i.test(approveRaw)) approve = true
    else if (/^(0|n|no|false)$/i.test(approveRaw)) approve = false
    else exitWith(`invalid vote value: ${approveRaw} (expected yes|no)`)
    const demos = await connect()
    const tx = await DemosTransactions.voteOnUpgrade(proposalId, approve, demos)
    const validation = await demos.confirm(tx)
    const result = await demos.broadcast(validation)
    console.log(pretty(result))
}

async function cmdVotes(proposalId: string) {
    if (!proposalId) exitWith("proposalId is required")
    const demos = new Demos()
    await demos.connect(RPC_URL)
    const tally = await demos.getProposalVotes(proposalId)
    console.log(pretty(tally))
}

async function cmdActiveProposals() {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    const list = await demos.getActiveProposals()
    console.log(`${list.length} open proposal(s):`)
    console.log(pretty(list))
}

async function cmdHistory() {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    const list = await demos.getUpgradeHistory()
    console.log(`${list.length} activated proposal(s):`)
    console.log(pretty(list))
}

async function cmdParams() {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    const params = await demos.getNetworkParameters()
    console.log(pretty(params))
}

async function cmdBlock() {
    const demos = new Demos()
    await demos.connect(RPC_URL)
    console.log(await demos.getLastBlockNumber())
}

// ---------- main ----------

function help() {
    console.log(`
Manual test helper — upgradable_network track.

  tsx scripts/manual_test_upgradable_network.ts <command> [args]

RPC_URL        = ${RPC_URL}
MNEMONIC_FILE  = ${MNEMONIC_FILE}

Wallet:
  new-wallet [file]                    Generate + save a fresh mnemonic.
                                       Fund the printed address in genesis
                                       before staking.

Chain info:
  block                                Last block number.
  params                               Current NetworkParameters.

Staking:
  stake [amount] [url]                 Stake (default amount = genesis min).
  unstake                              Request unstake (arms 1000-block lock).
  exit                                 Exit after lock elapsed.
  info [address]                       Validator record (current wallet by default).
  staked-amount [address]              Bare bigint string.
  validators [blockNumber]             List all validators.

Governance:
  propose <key> <value> [blockOffset]  Create proposal (default offset 160 blocks).
                                       key ∈ networkFee | rpcFee | minValidatorStake | featureFlags.
                                       featureFlags value must be JSON, e.g. '{"tlsn":false}'.
  vote <proposalId> <yes|no>           Cast vote.
  votes <proposalId>                   Live tally (approve/reject/threshold/passed).
  proposals                            Open proposals (pending/approved/activating).
  history                              Activated proposals.

Examples — bump networkFee from 10 → 12 (+20% so safety bounds pass):
  tsx scripts/manual_test_upgradable_network.ts propose networkFee 12
  tsx scripts/manual_test_upgradable_network.ts vote <proposalId> yes
  tsx scripts/manual_test_upgradable_network.ts votes <proposalId>
  tsx scripts/manual_test_upgradable_network.ts params            # after effectiveAtBlock
`)
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2)
    switch (cmd) {
        case "new-wallet":
            return cmdNewWallet(args[0])
        case "stake":
            return cmdStake(args[0], args[1])
        case "unstake":
            return cmdUnstake()
        case "exit":
            return cmdExit()
        case "info":
            return cmdInfo(args[0])
        case "staked-amount":
            return cmdStakedAmount(args[0])
        case "validators":
            return cmdValidators(args[0])
        case "propose":
            return cmdPropose(args[0], args[1], args[2])
        case "vote":
            return cmdVote(args[0], args[1])
        case "votes":
            return cmdVotes(args[0])
        case "proposals":
            return cmdActiveProposals()
        case "history":
            return cmdHistory()
        case "params":
            return cmdParams()
        case "block":
            return cmdBlock()
        case undefined:
        case "help":
        case "-h":
        case "--help":
            return help()
        default:
            help()
            exitWith(`\nUnknown command: ${cmd}`)
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
