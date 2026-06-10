/* eslint-disable no-console */
import { existsSync, readFileSync } from "node:fs"

import { demToOs } from "@kynesyslabs/demosdk/utils"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"

const DEFAULT_AMOUNT_DEM = "1_000_000_000"
const PEERLIST_FILE = "demos_peerlist.json"
const DEFAULT_IDENTITY_FILE = ".demos_identity"

const CONFIRM_TIMEOUT_MS = 20_000
const CONFIRM_POLL_INTERVAL_MS = 3_000

// Global context: parsed flags shared across every sub-command.
interface ValidatorContext {
    identity: string
    rpc: string
    amountDem: string
}

declare global {
    // eslint-disable-next-line no-var
    var validatorCtx: ValidatorContext
}

// ---------- small helpers ----------

function exitWith(msg: string, code = 1): never {
    console.error(msg)
    process.exit(code)
}

const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`
const purple = (s: string): string => `\x1b[35m${s}\x1b[0m`

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

function parseArgs(argv: string[]): {
    positionals: string[]
    flags: Record<string, string>
} {
    const positionals: string[] = []
    const flags: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg.startsWith("--")) {
            const key = arg.slice(2)
            const next = argv[i + 1]
            if (next === undefined || next.startsWith("--")) {
                flags[key] = "true"
            } else {
                flags[key] = next
                i++
            }
        } else {
            positionals.push(arg)
        }
    }
    return { positionals, flags }
}

function firstPeerlistRpc(): string {
    if (!existsSync(PEERLIST_FILE)) {
        exitWith(
            `${PEERLIST_FILE} not found. Pass --rpc <url> or create the peerlist.`,
        )
    }
    let peers: Record<string, string>
    try {
        peers = JSON.parse(readFileSync(PEERLIST_FILE, "utf8"))
    } catch {
        exitWith(`failed to parse ${PEERLIST_FILE}`)
    }
    const urls = Object.values(peers)
    if (urls.length === 0) {
        exitWith(`${PEERLIST_FILE} has no entries. Pass --rpc <url>.`)
    }
    return urls[0]
}

function loadMnemonic(file: string): string {
    if (!existsSync(file)) {
        exitWith(`identity file not found: ${file}`)
    }
    const mnemonic = readFileSync(file, "utf8").trim()
    if (!mnemonic) {
        exitWith(`identity file is empty: ${file}`)
    }
    return mnemonic
}

async function connect(): Promise<Demos> {
    const { rpc, identity } = globalThis.validatorCtx
    const demos = new Demos()
    await demos.connect(rpc)
    await demos.connectWallet(loadMnemonic(identity))

    console.log("------------------------------------------")
    console.log(`Identity:        ${identity}`)
    console.log(`Node public key: ${demos.getAddress()}`)
    console.log(`Network:         ${rpc}`)
    console.log("------------------------------------------ \n")

    return demos
}

/**
 * Poll getTransactionStatus every 3s for up to 20s. Resolves to the terminal
 * status (`included`/`failed`) once observed, or null if the wait times out.
 */
async function waitForInclusion(
    demos: Demos,
    hash: string,
): Promise<{ state: string; blockNumber?: number } | null> {
    const start = Date.now()
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
        const res = await demos.call("nodeCall", "getTransactionStatus", {
            hash,
        })
        const state =
            res && typeof res === "object"
                ? (res as { state?: string }).state
                : undefined
        if (state === "included" || state === "failed") {
            return {
                state,
                blockNumber: (res as { blockNumber?: number }).blockNumber,
            }
        }
        await sleep(CONFIRM_POLL_INTERVAL_MS)
    }
    return null
}

/**
 * Confirm + broadcast a signed tx, print its hash and expected confirmation
 * block, then wait for on-chain inclusion.
 */
async function submit(
    demos: Demos,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    label: string,
): Promise<void> {
    console.log(`${label}... \n`)

    const validation = await demos.confirm(tx)
    const hash = validation?.response?.data?.transaction?.hash
    if (!hash) {
        exitWith("could not extract transaction hash from confirmation")
    }

    const result = await demos.broadcast(validation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let confirmationBlock = (result as any)?.extra?.confirmationBlock
    if (confirmationBlock == null) {
        // Fallback: the next block is the earliest possible inclusion point.
        confirmationBlock = (await demos.getLastBlockNumber()) + 1
    }

    console.log(`Tx Hash  :  ${purple(hash)}`)
    console.log(`Block No.:  ${confirmationBlock} \n`)

    console.log("Waiting for on-chain confirmation...")
    const status = await waitForInclusion(demos, hash)

    if (status?.state === "included") {
        console.log(
            green(`✅ confirmed: included in block ${status.blockNumber} \n`),
        )
    } else if (status?.state === "failed") {
        console.log(
            yellow(`⚠️  transaction reported failed on-chain: ${hash} \n`),
        )
    } else {
        console.log(
            yellow(
                `⚠️  confirmation timed out: tx ${hash} not found on the network. Please the transaction status manually. \n`,
            ),
        )
    }
}

// ---------- commands ----------

async function cmdStake(): Promise<void> {
    const demos = await connect()
    const { amountDem, rpc } = globalThis.validatorCtx

    let amountOs: string
    try {
        amountOs = demToOs(amountDem).toString()
    } catch (e) {
        exitWith(
            `invalid --amount "${amountDem}": ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
    }
    if (BigInt(amountOs) <= 0n) {
        exitWith(`stake amount must be greater than 0 (got ${amountDem} DEM)`)
    }

    // The validator's public endpoint. Reuse the configured RPC so local and
    // devnet stacks work without an extra flag.
    const connectionUrl = rpc
    const tx = await DemosTransactions.stake(amountOs, connectionUrl, demos)
    await submit(demos, tx, `Staking ${amountDem} DEM`)
}

async function cmdUnstake(): Promise<void> {
    const demos = await connect()
    const tx = await DemosTransactions.unstake(demos)
    await submit(demos, tx, "Unstaking")
}

async function cmdExit(): Promise<void> {
    const demos = await connect()
    const tx = await DemosTransactions.validatorExit(demos)
    await submit(demos, tx, "Validator Exit")
}

// ---------- entry point ----------

async function main(): Promise<void> {
    const { positionals, flags } = parseArgs(process.argv.slice(2))
    const command = positionals[0]

    globalThis.validatorCtx = {
        identity: flags.identity ?? DEFAULT_IDENTITY_FILE,
        rpc: flags.rpc ?? firstPeerlistRpc(),
        amountDem: flags.amount ?? DEFAULT_AMOUNT_DEM,
    }

    switch (command) {
        case "stake":
            return cmdStake()
        case "unstake":
            return cmdUnstake()
        case "exit":
            return cmdExit()
        default:
            exitWith(
                `unknown command: ${command ?? "(none)"}\n` +
                    "usage: validator <stake|unstake|exit> " +
                    "[--amount <DEM>] [--identity <file>] [--rpc <url>]",
            )
    }
}

main().catch(e => exitWith(e))
