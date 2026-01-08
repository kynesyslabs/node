#!/usr/bin/env tsx

/**
 * L2PS Stress Test - Send multiple transactions from multiple wallets
 *
 * Usage: npx tsx scripts/l2ps-stress-test.ts --uid testnet_l2ps_001 --count 100
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import forge from "node-forge"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { L2PS, L2PSEncryptedPayload } from "@kynesyslabs/demosdk/l2ps"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getErrorMessage } from "@/utilities/errorMessage"

interface WalletInfo {
    index: number
    address: string
    mnemonic: string
}

interface WalletsFile {
    wallets: WalletInfo[]
}

interface CliOptions {
    nodeUrl: string
    uid: string
    walletsFile: string
    count: number
    value: number
    concurrency: number
    delayMs: number
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        nodeUrl: "http://127.0.0.1:53550",
        uid: "testnet_l2ps_001",
        walletsFile: "data/test-wallets.json",
        count: 100,
        value: 10,
        concurrency: 5,
        delayMs: 100,
    }

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--node" && argv[i + 1]) {
            options.nodeUrl = argv[i + 1]
            i++
        } else if (arg === "--uid" && argv[i + 1]) {
            options.uid = argv[i + 1]
            i++
        } else if (arg === "--wallets-file" && argv[i + 1]) {
            options.walletsFile = argv[i + 1]
            i++
        } else if (arg === "--count" && argv[i + 1]) {
            options.count = parseInt(argv[i + 1], 10)
            i++
        } else if (arg === "--value" && argv[i + 1]) {
            options.value = parseInt(argv[i + 1], 10)
            i++
        } else if (arg === "--concurrency" && argv[i + 1]) {
            options.concurrency = parseInt(argv[i + 1], 10)
            i++
        } else if (arg === "--delay" && argv[i + 1]) {
            options.delayMs = parseInt(argv[i + 1], 10)
            i++
        } else if (arg === "--help") {
            console.log(`
Usage: npx tsx scripts/l2ps-stress-test.ts [options]

Options:
  --node <url>           Node RPC URL (default: http://127.0.0.1:53550)
  --uid <uid>            L2PS network UID (default: testnet_l2ps_001)
  --wallets-file <path>  Path to wallets JSON file (default: data/test-wallets.json)
  --count <n>            Total number of transactions (default: 100)
  --value <amount>       Amount per transaction (default: 10)
  --concurrency <n>      Number of parallel senders (default: 5)
  --delay <ms>           Delay between transactions in ms (default: 100)
  --help                 Show this help
`)
            process.exit(0)
        }
    }

    return options
}

function normalizeHex(address: string): string {
    const cleaned = address.trim()
    const hex = cleaned.startsWith("0x") ? cleaned : `0x${cleaned}`
    return hex.toLowerCase()
}

function sanitizeHexValue(value: string, label: string): string {
    const cleaned = value.trim().replace(/^0x/, "").replaceAll(/\s+/g, "")
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
        throw new Error(`${label} contains non-hex characters`)
    }
    return cleaned.toLowerCase()
}

function resolveL2psKeyMaterial(uid: string): { privateKey: string; iv: string } {
    const configPath = path.resolve("data", "l2ps", uid, "config.json")

    if (!existsSync(configPath)) {
        throw new Error(`L2PS config not found: ${configPath}`)
    }

    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    const keyPath = config.keys?.private_key_path
    const ivPath = config.keys?.iv_path

    if (!keyPath || !ivPath) {
        throw new Error("Missing L2PS key material in config")
    }

    const privateKey = readFileSync(path.resolve(keyPath), "utf-8").trim()
    const iv = readFileSync(path.resolve(ivPath), "utf-8").trim()

    return { privateKey, iv }
}

async function buildInnerTransaction(
    demos: Demos,
    to: string,
    amount: number,
    l2psUid: string,
): Promise<Transaction> {
    const tx = await demos.tx.prepare()
    tx.content.type = "native" as Transaction["content"]["type"]
    tx.content.to = normalizeHex(to)
    tx.content.amount = amount
    tx.content.data = ["native", {
        nativeOperation: "send",
        args: [normalizeHex(to), amount],
        l2ps_uid: l2psUid,
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

interface TxResult {
    success: boolean
    fromWallet: number
    toWallet: number
    outerHash?: string
    error?: string
    duration: number
}

async function sendTransaction(
    demos: Demos,
    l2ps: L2PS,
    fromAddress: string,
    toAddress: string,
    amount: number,
    nonce: number,
    uid: string,
): Promise<{ outerHash: string; innerHash: string }> {
    const innerTx = await buildInnerTransaction(demos, toAddress, amount, uid)
    const encryptedTx = await l2ps.encryptTx(innerTx)
    const [, encryptedPayload] = encryptedTx.content.data

    const subnetTx = await buildL2PSTransaction(
        demos,
        encryptedPayload as L2PSEncryptedPayload,
        toAddress,
        nonce,
    )

    const validityResponse = await demos.confirm(subnetTx)
    const validityData = validityResponse.response

    if (!validityData?.data?.valid) {
        throw new Error(validityData?.data?.message ?? "Transaction invalid")
    }

    await demos.broadcast(validityResponse)

    return { outerHash: subnetTx.hash, innerHash: innerTx.hash }
}

async function main() {
    const options = parseArgs(process.argv)

    console.log(`\n🚀 L2PS Stress Test`)
    console.log(`   Node: ${options.nodeUrl}`)
    console.log(`   UID: ${options.uid}`)
    console.log(`   Total transactions: ${options.count}`)
    console.log(`   Value per tx: ${options.value}`)
    console.log(`   Concurrency: ${options.concurrency}`)
    console.log(`   Delay: ${options.delayMs}ms`)

    // Load wallets
    const walletsPath = path.resolve(options.walletsFile)
    if (!existsSync(walletsPath)) {
        throw new Error(`Wallets file not found: ${walletsPath}\nRun: npx tsx scripts/generate-test-wallets.ts first`)
    }

    const walletsData: WalletsFile = JSON.parse(readFileSync(walletsPath, "utf-8"))
    const wallets = walletsData.wallets

    if (wallets.length < 2) {
        throw new Error("Need at least 2 wallets for stress test")
    }

    console.log(`\n📂 Loaded ${wallets.length} wallets from ${options.walletsFile}`)

    // Load L2PS key material
    const { privateKey, iv } = resolveL2psKeyMaterial(options.uid)
    const hexKey = sanitizeHexValue(privateKey, "L2PS key")
    const hexIv = sanitizeHexValue(iv, "L2PS IV")
    const keyBytes = forge.util.hexToBytes(hexKey)
    const ivBytes = forge.util.hexToBytes(hexIv)

    // Initialize wallet connections
    console.log(`\n🔌 Connecting wallets...`)
    const walletConnections: { demos: Demos; l2ps: L2PS; address: string; nonce: number }[] = []

    for (const wallet of wallets) {
        const demos = new Demos()
        await demos.connect(options.nodeUrl)
        await demos.connectWallet(wallet.mnemonic)

        const l2ps = await L2PS.create(keyBytes, ivBytes)
        l2ps.setConfig({ uid: options.uid, config: { created_at_block: 0, known_rpcs: [options.nodeUrl] } })

        const ed25519Address = await demos.getEd25519Address()
        const nonce = (await demos.getAddressNonce(ed25519Address)) + 1

        walletConnections.push({
            demos,
            l2ps,
            address: normalizeHex(ed25519Address),
            nonce,
        })

        console.log(`   ✅ Wallet ${wallet.index}: ${wallet.address.slice(0, 20)}... (nonce: ${nonce})`)
    }

    // Run stress test
    console.log(`\n🔥 Starting stress test...`)
    const startTime = Date.now()
    const results: TxResult[] = []
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < options.count; i++) {
        // Pick random sender and receiver (different wallets)
        const senderIdx = i % walletConnections.length
        let receiverIdx = (senderIdx + 1 + Math.floor(Math.random() * (walletConnections.length - 1))) % walletConnections.length

        const sender = walletConnections[senderIdx]
        const receiver = walletConnections[receiverIdx]

        const txStart = Date.now()
        try {
            const { outerHash } = await sendTransaction(
                sender.demos,
                sender.l2ps,
                sender.address,
                receiver.address,
                options.value,
                sender.nonce++,
                options.uid,
            )

            successCount++
            results.push({
                success: true,
                fromWallet: senderIdx + 1,
                toWallet: receiverIdx + 1,
                outerHash,
                duration: Date.now() - txStart,
            })

            if ((i + 1) % 10 === 0 || i === options.count - 1) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                const tps = (successCount / parseFloat(elapsed)).toFixed(2)
                console.log(`   📊 Progress: ${i + 1}/${options.count} | Success: ${successCount} | Failed: ${failCount} | TPS: ${tps}`)
            }
        } catch (error) {
            failCount++
            results.push({
                success: false,
                fromWallet: senderIdx + 1,
                toWallet: receiverIdx + 1,
                error: getErrorMessage(error),
                duration: Date.now() - txStart,
            })
        }

        // Delay between transactions
        if (options.delayMs > 0 && i < options.count - 1) {
            await new Promise(resolve => setTimeout(resolve, options.delayMs))
        }
    }

    // Summary
    const totalTime = (Date.now() - startTime) / 1000
    const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length

    console.log(`\n🎉 Stress Test Complete!`)
    console.log(`\n📊 Results:`)
    console.log(`   Total transactions: ${options.count}`)
    console.log(`   Successful: ${successCount} (${(successCount / options.count * 100).toFixed(1)}%)`)
    console.log(`   Failed: ${failCount} (${(failCount / options.count * 100).toFixed(1)}%)`)
    console.log(`   Total time: ${totalTime.toFixed(2)}s`)
    console.log(`   Average TPS: ${(successCount / totalTime).toFixed(2)}`)
    console.log(`   Avg tx duration: ${avgDuration.toFixed(0)}ms`)

    if (failCount > 0) {
        console.log(`\n❌ Failed transactions:`)
        results.filter(r => !r.success).slice(0, 5).forEach(r => {
            console.log(`   Wallet ${r.fromWallet} → ${r.toWallet}: ${r.error}`)
        })
        if (failCount > 5) {
            console.log(`   ... and ${failCount - 5} more`)
        }
    }

    console.log(`\n💡 Check the database for proof count:`)
    console.log(`   Expected: ~${Math.ceil(successCount / 10)} proofs (1 per batch of up to 10 txs)`)
    console.log(`   Before fix: Would have been ${successCount} proofs (1 per tx)`)
}

main().catch(err => {
    console.error("❌ Error:", err.message)
    if (err.stack) console.error(err.stack)
    process.exit(1)
})
