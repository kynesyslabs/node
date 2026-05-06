#!/usr/bin/env tsx

/**
 * Generate test wallets and add them to genesis.json
 *
 * Usage: npx tsx scripts/generate-test-wallets.ts --count 10 --balance 1000000000000000000
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import * as bip39 from "bip39"

interface CliOptions {
    count: number
    balance: string
    genesisPath: string
    outputPath: string
}

type ArgHandler = (options: CliOptions, value: string) => void

const ARG_HANDLERS: Record<string, ArgHandler> = {
    "--count": (opts, val) => { opts.count = Number.parseInt(val, 10) },
    "--balance": (opts, val) => { opts.balance = val },
    "--genesis": (opts, val) => { opts.genesisPath = val },
    "--output": (opts, val) => { opts.outputPath = val },
}

function showHelp(): never {
    console.log(`
Usage: npx tsx scripts/generate-test-wallets.ts [options]

Options:
  --count <n>        Number of wallets to generate (default: 10)
  --balance <amount> Balance for each wallet (default: 1000000000000000000)
  --genesis <path>   Path to genesis.json (default: data/genesis.json)
  --output <path>    Output file for wallet mnemonics (default: data/test-wallets.json)
  --help             Show this help
`)
    process.exit(0)
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        count: 10,
        balance: "1000000000000000000",
        genesisPath: "data/genesis.json",
        outputPath: "data/test-wallets.json",
    }

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]

        if (arg === "--help") {
            showHelp()
        }

        const handler = ARG_HANDLERS[arg]
        if (handler && argv[i + 1]) {
            handler(options, argv[i + 1])
            i++
        }
    }

    return options
}

async function generateWallet(): Promise<{ mnemonic: string; address: string }> {
    const mnemonic = bip39.generateMnemonic(256)
    const demos = new Demos()
    await demos.connectWallet(mnemonic)
    const address = await demos.getEd25519Address()
    return { mnemonic, address: address.startsWith("0x") ? address : `0x${address}` }
}

async function main() {
    const options = parseArgs(process.argv)

    console.log(`\n🔧 Generating ${options.count} test wallets...`)
    console.log(`   Balance per wallet: ${options.balance}`)

    // Read existing genesis
    const genesisPath = path.resolve(options.genesisPath)
    if (!existsSync(genesisPath)) {
        throw new Error(`Genesis file not found: ${genesisPath}`)
    }

    const genesis = JSON.parse(readFileSync(genesisPath, "utf-8"))
    const existingAddresses = new Set(genesis.balances.map((b: [string, string]) => b[0].toLowerCase()))

    console.log(`   Existing wallets in genesis: ${genesis.balances.length}`)

    // Generate new wallets
    const newWallets: { mnemonic: string; address: string; index: number }[] = []

    let generatedCount = 0
    while (generatedCount < options.count) {
        const wallet = await generateWallet()

        // Skip if already exists
        if (existingAddresses.has(wallet.address.toLowerCase())) {
            console.log(`   ⚠️  Wallet ${generatedCount + 1} already exists, regenerating...`)
            continue
        }

        newWallets.push({ ...wallet, index: generatedCount + 1 })
        existingAddresses.add(wallet.address.toLowerCase())

        // Add to genesis balances
        genesis.balances.push([wallet.address, options.balance])

        console.log(`   ✅ Wallet ${generatedCount + 1}: ${wallet.address.slice(0, 20)}...`)
        generatedCount++
    }

    // Save updated genesis
    writeFileSync(genesisPath, JSON.stringify(genesis, null, 4))
    console.log(`\n📝 Updated genesis.json with ${newWallets.length} new wallets`)
    console.log(`   Total wallets in genesis: ${genesis.balances.length}`)

    // Save wallet mnemonics to file
    const outputPath = path.resolve(options.outputPath)
    const walletsData = {
        generated_at: new Date().toISOString(),
        count: newWallets.length,
        balance: options.balance,
        wallets: newWallets.map(w => ({
            index: w.index,
            address: w.address,
            mnemonic: w.mnemonic,
        })),
    }
    writeFileSync(outputPath, JSON.stringify(walletsData, null, 2))
    console.log(`\n💾 Saved wallet mnemonics to: ${outputPath}`)

    console.log("\n⚠️  IMPORTANT: Restart your node for genesis changes to take effect!")
    console.log("\n📋 Summary:")
    console.log(`   New wallets: ${newWallets.length}`)
    console.log(`   Mnemonics saved to: ${outputPath}`)
    console.log("\n🧪 To run stress test after restart:")
    console.log(`   npx tsx scripts/l2ps-stress-test.ts --wallets-file ${options.outputPath} --count 100`)
}

main().catch(err => {
    console.error("❌ Error:", err.message)
    process.exit(1)
})
