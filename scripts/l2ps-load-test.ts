#!/usr/bin/env tsx

/**
 * L2PS Load Test - Send many transactions from single wallet to multiple recipients
 * Uses existing genesis wallets as recipients - no restart needed!
 *
 * Usage: npx tsx scripts/l2ps-load-test.ts --uid testnet_l2ps_001 --count 100
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import forge from "node-forge"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { L2PS, L2PSEncryptedPayload } from "@kynesyslabs/demosdk/l2ps"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getErrorMessage } from "@/utilities/errorMessage"

interface CliOptions {
    nodeUrl: string
    uid: string
    mnemonicFile: string
    count: number
    value: number
    delayMs: number
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        nodeUrl: "http://127.0.0.1:53550",
        uid: "testnet_l2ps_001",
        mnemonicFile: "mnemonic.txt",
        count: 100,
        value: 1,
        delayMs: 50,
    }

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--node" && argv[i + 1]) {
            options.nodeUrl = argv[i + 1]
            i++
        } else if (arg === "--uid" && argv[i + 1]) {
            options.uid = argv[i + 1]
            i++
        } else if (arg === "--mnemonic-file" && argv[i + 1]) {
            options.mnemonicFile = argv[i + 1]
            i++
        } else if (arg === "--count" && argv[i + 1]) {
            options.count = parseInt(argv[i + 1], 10)
            i++
        } else if (arg === "--value" && argv[i + 1]) {
            options.value = parseInt(argv[i + 1], 10)
            i++
        } else if (arg === "--delay" && argv[i + 1]) {
            options.delayMs = parseInt(argv[i + 1], 10)
            i++
        } else if (arg === "--help") {
            console.log(`
Usage: npx tsx scripts/l2ps-load-test.ts [options]

Options:
  --node <url>           Node RPC URL (default: http://127.0.0.1:53550)
  --uid <uid>            L2PS network UID (default: testnet_l2ps_001)
  --mnemonic-file <path> Path to mnemonic file (default: mnemonic.txt)
  --count <n>            Total number of transactions (default: 100)
  --value <amount>       Amount per transaction (default: 1)
  --delay <ms>           Delay between transactions in ms (default: 50)
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

function loadGenesisRecipients(): string[] {
    const genesisPath = path.resolve("data/genesis.json")
    if (!existsSync(genesisPath)) {
        throw new Error("Genesis file not found")
    }

    const genesis = JSON.parse(readFileSync(genesisPath, "utf-8"))
    return genesis.balances.map((b: [string, string]) => normalizeHex(b[0]))
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

async function main() {
    const options = parseArgs(process.argv)

    console.log(`\n🚀 L2PS Load Test`)
    console.log(`   Node: ${options.nodeUrl}`)
    console.log(`   UID: ${options.uid}`)
    console.log(`   Total transactions: ${options.count}`)
    console.log(`   Value per tx: ${options.value}`)
    console.log(`   Delay: ${options.delayMs}ms`)

    // Load mnemonic
    const mnemonicPath = path.resolve(options.mnemonicFile)
    if (!existsSync(mnemonicPath)) {
        throw new Error(`Mnemonic file not found: ${mnemonicPath}`)
    }
    const mnemonic = readFileSync(mnemonicPath, "utf-8").trim()

    // Load genesis recipients
    const recipients = loadGenesisRecipients()
    console.log(`\n📂 Loaded ${recipients.length} recipients from genesis`)

    // Load L2PS key material
    const { privateKey, iv } = resolveL2psKeyMaterial(options.uid)
    const hexKey = sanitizeHexValue(privateKey, "L2PS key")
    const hexIv = sanitizeHexValue(iv, "L2PS IV")
    const keyBytes = forge.util.hexToBytes(hexKey)
    const ivBytes = forge.util.hexToBytes(hexIv)

    // Connect wallet
    console.log(`\n🔌 Connecting wallet...`)
    const demos = new Demos()
    await demos.connect(options.nodeUrl)
    await demos.connectWallet(mnemonic)

    const l2ps = await L2PS.create(keyBytes, ivBytes)
    l2ps.setConfig({ uid: options.uid, config: { created_at_block: 0, known_rpcs: [options.nodeUrl] } })

    const senderAddress = normalizeHex(await demos.getEd25519Address())
    let nonce = (await demos.getAddressNonce(senderAddress)) + 1

    console.log(`   Sender: ${senderAddress.slice(0, 20)}...`)
    console.log(`   Starting nonce: ${nonce}`)

    // Filter out sender from recipients
    const validRecipients = recipients.filter(r => r !== senderAddress)
    if (validRecipients.length === 0) {
        throw new Error("No valid recipients found (sender is the only wallet)")
    }

    console.log(`   Valid recipients: ${validRecipients.length}`)

    // Run load test
    console.log(`\n🔥 Starting load test...`)
    const startTime = Date.now()
    let successCount = 0
    let failCount = 0
    const errors: string[] = []

    for (let i = 0; i < options.count; i++) {
        // Round-robin through recipients
        const recipient = validRecipients[i % validRecipients.length]

        try {
            const innerTx = await buildInnerTransaction(demos, recipient, options.value, options.uid)
            const encryptedTx = await l2ps.encryptTx(innerTx)
            const [, encryptedPayload] = encryptedTx.content.data

            const subnetTx = await buildL2PSTransaction(
                demos,
                encryptedPayload as L2PSEncryptedPayload,
                recipient,
                nonce++,
            )

            const validityResponse = await demos.confirm(subnetTx)
            const validityData = validityResponse.response

            if (!validityData?.data?.valid) {
                throw new Error(validityData?.data?.message ?? "Transaction invalid")
            }

            await demos.broadcast(validityResponse)
            successCount++

        } catch (error) {
            failCount++
            const errMsg = getErrorMessage(error)
            if (!errors.includes(errMsg)) {
                errors.push(errMsg)
            }
        }

        // Progress update every 10 transactions
        if ((i + 1) % 10 === 0 || i === options.count - 1) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            const tps = (successCount / Math.max(parseFloat(elapsed), 0.1)).toFixed(2)
            console.log(`   📊 Progress: ${i + 1}/${options.count} | ✅ ${successCount} | ❌ ${failCount} | TPS: ${tps}`)
        }

        // Delay between transactions
        if (options.delayMs > 0 && i < options.count - 1) {
            await new Promise(resolve => setTimeout(resolve, options.delayMs))
        }
    }

    // Summary
    const totalTime = (Date.now() - startTime) / 1000

    console.log(`\n🎉 Load Test Complete!`)
    console.log(`\n📊 Results:`)
    console.log(`   Total transactions: ${options.count}`)
    console.log(`   Successful: ${successCount} (${(successCount / options.count * 100).toFixed(1)}%)`)
    console.log(`   Failed: ${failCount} (${(failCount / options.count * 100).toFixed(1)}%)`)
    console.log(`   Total time: ${totalTime.toFixed(2)}s`)
    console.log(`   Average TPS: ${(successCount / totalTime).toFixed(2)}`)

    if (errors.length > 0) {
        console.log(`\n❌ Unique errors (${errors.length}):`)
        errors.slice(0, 5).forEach(e => console.log(`   - ${e}`))
    }

    // Expected proof count
    const expectedBatches = Math.ceil(successCount / 10)
    console.log(`\n💡 Expected results after batch aggregation:`)
    console.log(`   Batches (max 10 tx each): ~${expectedBatches}`)
    console.log(`   Proofs in DB: ~${expectedBatches} (1 per batch)`)
    console.log(`   L1 transactions: ~${expectedBatches}`)
    console.log(`\n   ⚠️  Before fix: Would have been ${successCount} proofs!`)

    console.log(`\n⏳ Wait ~15 seconds for batch aggregation, then check DB`)
}

main().catch(err => {
    console.error("❌ Error:", err.message)
    if (err.stack) console.error(err.stack)
    process.exit(1)
})
