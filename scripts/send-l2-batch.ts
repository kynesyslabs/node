#!/usr/bin/env tsx

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import forge from "node-forge"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { L2PS, L2PSEncryptedPayload } from "@kynesyslabs/demosdk/l2ps"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getErrorMessage } from "@/utilities/errorMessage"

interface CliOptions {
    nodeUrl: string
    uid: string
    configPath?: string
    keyPath?: string
    ivPath?: string
    mnemonic?: string
    mnemonicFile?: string
    from?: string
    to?: string
    value?: string
    data?: string
    count: number
    waitStatus: boolean
    type: string
}

interface TxPayload {
    message?: string
    l2ps_uid?: string
    [key: string]: unknown
}

function printUsage(): void {
    console.log(`
Usage: npx tsx scripts/send-l2-batch.ts --uid <uid> --mnemonic "words..." [options]

Required:
  --uid <uid>              L2PS network UID (e.g. testnet_l2ps_001)
  --mnemonic <words>       Wallet mnemonic (or use --mnemonic-file)

Optional:
  --node <url>             Node RPC URL (default http://127.0.0.1:53550)
  --config <path>          Path to L2PS config (defaults to data/l2ps/<uid>/config.json)
  --key <path>             AES key file for L2PS (overrides config)
  --iv <path>              IV file for L2PS (overrides config)
  --from <address>         Override sender (defaults to wallet address)
  --to <address>           Recipient address (defaults to sender)
  --value <amount>         Transaction amount (defaults to 0)
  --data <string>          Attach arbitrary payload string
  --type <string>          Native operation type (default: send)
  --count <n>              Number of transactions to send (default: 5)
  --wait                   Poll transaction status after submission
  --mnemonic-file <path>   Read mnemonic from a file
  --help                   Show this help message
`)
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        nodeUrl: "http://127.0.0.1:53550",
        uid: "",
        configPath: undefined,
        keyPath: undefined,
        ivPath: undefined,
        mnemonic: process.env.DEMOS_MNEMONIC,
        mnemonicFile: undefined,
        from: undefined,
        to: undefined,
        value: undefined,
        data: undefined,
        count: 5,
        waitStatus: false,
        type: "send",
    }

    const argsWithValues = new Set([
        "--node", "--uid", "--config", "--key", "--iv",
        "--mnemonic", "--mnemonic-file", "--from", "--to",
        "--value", "--data", "--count", "--type",
    ])

    const flagHandlers: Record<string, (value?: string) => void> = {
        "--node": (value) => {
            if (!value) throw new Error("--node requires a value")
            options.nodeUrl = value
        },
        "--uid": (value) => {
            if (!value) throw new Error("--uid requires a value")
            options.uid = value
        },
        "--config": (value) => { options.configPath = value },
        "--key": (value) => { options.keyPath = value },
        "--iv": (value) => { options.ivPath = value },
        "--mnemonic": (value) => { options.mnemonic = value },
        "--mnemonic-file": (value) => { options.mnemonicFile = value },
        "--from": (value) => { options.from = value },
        "--to": (value) => { options.to = value },
        "--value": (value) => { options.value = value },
        "--data": (value) => { options.data = value },
        "--type": (value) => {
            if (!value) throw new Error("--type requires a value")
            options.type = value
        },
        "--count": (value) => {
            if (!value) throw new Error("--count requires a value")
            const count = Number.parseInt(value, 10)
            if (!Number.isInteger(count) || count < 1) {
                throw new Error("--count must be at least 1")
            }
            options.count = count
        },
        "--wait": () => { options.waitStatus = true },
        "--help": () => {
            printUsage()
            process.exit(0)
        },
    }

    let idx = 2
    while (idx < argv.length) {
        const arg = argv[idx]
        if (!arg.startsWith("--")) {
            idx += 1
            continue
        }

        const handler = flagHandlers[arg]
        if (!handler) {
            throw new Error(`Unknown argument: ${arg}`)
        }

        const hasValue = argsWithValues.has(arg)
        const value = hasValue ? argv[idx + 1] : undefined
        handler(value)
        idx += hasValue ? 2 : 1
    }

    if (!options.uid) {
        printUsage()
        throw new Error("Missing required argument --uid")
    }

    return options
}

function normalizeHex(address: string, label = "Address"): string {
    if (!address) {
        throw new Error(`${label} is required`)
    }

    const cleaned = address.trim()
    const hex = cleaned.startsWith("0x") ? cleaned : `0x${cleaned}`

    if (hex.length !== 66) {
        throw new Error(`${label} invalid: Expected 64 hex characters (32 bytes) with 0x prefix, but got ${hex.length - 2} characters.`)
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`${label} contains invalid hex characters.`)
    }

    return hex.toLowerCase()
}

function readRequiredFile(filePath: string, label: string): string {
    const resolved = path.resolve(filePath)
    if (!existsSync(resolved)) {
        throw new Error(`Missing ${label} file at ${resolved}`)
    }
    return readFileSync(resolved, "utf-8").trim()
}

function loadMnemonic(options: CliOptions): string {
    if (options.mnemonic) {
        return options.mnemonic.trim()
    }

    if (options.mnemonicFile) {
        return readRequiredFile(options.mnemonicFile, "mnemonic")
    }

    // Try default mnemonic.txt in current dir
    if (existsSync("mnemonic.txt")) {
        console.log("ℹ️  Using default mnemonic.txt file")
        return readFileSync("mnemonic.txt", "utf-8").trim()
    }

    throw new Error(
        "Wallet mnemonic required. Provide --mnemonic, --mnemonic-file, or set DEMOS_MNEMONIC.",
    )
}

function resolveL2psKeyMaterial(options: CliOptions): { privateKey: string; iv: string } {
    let keyPath = options.keyPath
    let ivPath = options.ivPath

    const defaultConfigPath =
        options.configPath || path.join("data", "l2ps", options.uid, "config.json")
    const resolvedConfigPath = path.resolve(defaultConfigPath)

    if ((!keyPath || !ivPath) && existsSync(resolvedConfigPath)) {
        try {
            const config = JSON.parse(
                readFileSync(resolvedConfigPath, "utf-8"),
            )
            keyPath = keyPath || config.keys?.private_key_path
            ivPath = ivPath || config.keys?.iv_path
        } catch (error) {
            const errorMessage = getErrorMessage(error)
            throw new Error(`Failed to parse L2PS config ${resolvedConfigPath}: ${errorMessage}`)
        }
    }

    if (!keyPath || !ivPath) {
        throw new Error(
            "Missing L2PS key material. Provide --key/--iv or a config file with keys.private_key_path and keys.iv_path.",
        )
    }

    const privateKey = readRequiredFile(keyPath, "L2PS key")
    const iv = readRequiredFile(ivPath, "L2PS IV")

    return { privateKey, iv }
}

function sanitizeHexValue(value: string, label: string): string {
    if (!value || typeof value !== "string") {
        throw new Error(`Missing ${label}`)
    }

    const cleaned = value.trim().replace(/^0x/, "").replaceAll(/\s+/g, "")

    if (cleaned.length === 0) {
        throw new Error(`${label} is empty`)
    }

    if (cleaned.length % 2 !== 0) {
        throw new Error(`${label} has invalid length (must be even number of hex chars)`)
    }

    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
        throw new Error(`${label} contains non-hex characters`)
    }

    return cleaned.toLowerCase()
}

async function buildInnerTransaction(
    demos: Demos,
    to: string,
    amount: number,
    payload: TxPayload,
    operation = "send",
): Promise<Transaction> {
    const tx = await demos.tx.prepare()
    tx.content.type = "native" as Transaction["content"]["type"]
    tx.content.to = normalizeHex(to)
    tx.content.amount = amount
    // Format as native payload with send operation for L2PSTransactionExecutor
    tx.content.data = ["native", {
        nativeOperation: operation,
        args: [normalizeHex(to), amount],
        ...payload,  // Include l2ps_uid and other metadata
    }] as unknown as Transaction["content"]["data"]
    tx.content.timestamp = Date.now()

    return demos.sign(tx)
}

async function buildL2PSTransaction(
    demos: Demos,
    payload: L2PSEncryptedPayload,
    to: string,
    nonce: number,
): Promise<Transaction> {
    const tx = await demos.tx.prepare()
    tx.content.type = "l2psEncryptedTx" as Transaction["content"]["type"]
    tx.content.to = normalizeHex(to)
    tx.content.amount = 0
    tx.content.data = ["l2psEncryptedTx", payload] as unknown as Transaction["content"]["data"]
    tx.content.nonce = nonce
    tx.content.timestamp = Date.now()

    return demos.sign(tx)
}

async function waitForStatus(demos: Demos, txHash: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const status = await demos.getTxByHash(txHash)
    console.log("📦 Status:", status)
}

try {
    const options = parseArgs(process.argv)
    const mnemonic = loadMnemonic(options)
    const { privateKey, iv } = resolveL2psKeyMaterial(options)

    const demos = new Demos()
    console.log(`🌐 Connecting to ${options.nodeUrl}...`)
    await demos.connect(options.nodeUrl)

    console.log("🔑 Connecting wallet...")
    await demos.connectWallet(mnemonic)

    const signerAddress = normalizeHex(await demos.getAddress(), "Wallet address")
    const ed25519Address = normalizeHex(await demos.getEd25519Address(), "Ed25519 address")
    const fromAddress = normalizeHex(options.from || signerAddress, "From address")
    const nonceAccount = options.from ? fromAddress : ed25519Address
    const toAddress = normalizeHex(options.to || fromAddress, "To address")

    console.log(`\n📦 Preparing to send ${options.count} L2 transactions...`)
    console.log(`   From: ${fromAddress}`)
    console.log(`   To: ${toAddress}`)

    const hexKey = sanitizeHexValue(privateKey, "L2PS key")
    const hexIv = sanitizeHexValue(iv, "L2PS IV")
    const keyBytes = forge.util.hexToBytes(hexKey)
    const ivBytes = forge.util.hexToBytes(hexIv)

    const l2ps = await L2PS.create(keyBytes, ivBytes)
    l2ps.setConfig({ uid: options.uid, config: { created_at_block: 0, known_rpcs: [options.nodeUrl] } })

    const results = []
    const amount = options.value ? Number(options.value) : 0

    // Get initial nonce and track locally to avoid conflicts
    let currentNonce = (await demos.getAddressNonce(nonceAccount)) + 1
    console.log(`   Starting nonce: ${currentNonce}`)

    for (let i = 0; i < options.count; i++) {
        console.log(`\n🔄 Transaction ${i + 1}/${options.count} (nonce: ${currentNonce})`)

        const payload: TxPayload = {
            l2ps_uid: options.uid,
        }
        if (options.data) {
            payload.message = `${options.data} [${i + 1}/${options.count}]`
        }

        console.log("  🧱 Building inner transaction (L2 payload)...")
        const innerTx = await buildInnerTransaction(
            demos,
            toAddress,
            amount,
            payload,
            options.type,
        )

        console.log("  🔐 Encrypting with L2PS key material...")
        const encryptedTx = await l2ps.encryptTx(innerTx)
        const [, encryptedPayload] = encryptedTx.content.data

        console.log("  🧱 Building outer L2PS transaction...")
        const subnetTx = await buildL2PSTransaction(
            demos,
            encryptedPayload as L2PSEncryptedPayload,
            toAddress,
            currentNonce,
        )

        console.log("  ✅ Confirming transaction with node...")
        const validityResponse = await demos.confirm(subnetTx)
        const validityData = validityResponse.response

        if (!validityData?.data?.valid) {
            throw new Error(
                `Transaction invalid: ${validityData?.data?.message ?? "Unknown error"}`,
            )
        }

        console.log("  📤 Broadcasting encrypted L2PS transaction to L1...")
        const broadcastResponse = await demos.broadcast(validityResponse)

        const txResult = {
            index: i + 1,
            hash: subnetTx.hash,
            innerHash: innerTx.hash,
            nonce: currentNonce,
            payload: payload,
            response: broadcastResponse,
        }

        results.push(txResult)

        console.log(`  ✅ Outer hash: ${subnetTx.hash}`)
        console.log(`  ✅ Inner hash: ${innerTx.hash}`)

        // Increment nonce for next transaction
        currentNonce++

        // Large delay between transactions to reduce I/O pressure on WSL/Node
        if (i < options.count - 1) {
            console.log("  ⏳ Waiting 2s before next transaction...")
            // await new Promise(resolve => setTimeout(resolve, 2000))
        }
    }

    console.log(`\n🎉 Successfully submitted ${results.length} L2 transactions!`)
    console.log("\n📋 Transaction Summary:")
    results.forEach(r => {
        console.log(`  ${r.index}. Outer: ${r.hash}`)
        console.log(`     Inner: ${r.innerHash}`)
    })

    console.log(`\n💡 Transactions are now in L2PS mempool (UID: ${options.uid})`)
    console.log("   The L2PS loop will:")
    console.log("   1. Collect these transactions from L2PS mempool")
    console.log("   2. Encrypt them together")
    console.log("   3. Create ONE consolidated encrypted transaction")
    console.log("   4. Broadcast it to L1 main mempool")
    console.log("\n⚠️  Check L2PS loop logs to confirm processing")

    if (options.waitStatus) {
        console.log("\n⏳ Fetching transaction statuses...")
        for (const result of results) {
            console.log(`\n📦 Status for transaction ${result.index} (${result.hash}):`)
            await waitForStatus(demos, result.hash)
        }
    }
} catch (error) {
    console.error("❌ Failed to send L2 transactions")
    if (error instanceof Error) {
        console.error(error.message)
        console.error(error.stack)
    } else {
        console.error(error)
    }
    process.exit(1)
}
