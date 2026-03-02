#!/usr/bin/env tsx
/**
 * Unified ZK Setup Script - Sets up both ZK Identity and L2PS ZK systems
 *
 * This script handles the complete ZK setup for the DEMOS node:
 * 1. ZK Identity System (src/features/zk/) - User identity attestations
 * 2. L2PS ZK System (src/libs/l2ps/zk/) - Private batch transactions
 *
 * Run with: bun run zk:setup
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { execSync, spawn } from "child_process"
import { join, resolve, dirname } from "path"
import { createHash, randomBytes } from "crypto"
import { fileURLToPath } from "url"

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Root paths
const ROOT_DIR = resolve(__dirname, "../")
const ZK_IDENTITY_DIR = join(ROOT_DIR, "src/features/zk")
const L2PS_ZK_DIR = join(ROOT_DIR, "src/libs/l2ps/zk")

// Use local snarkjs from node_modules for better cross-system compatibility
const SNARKJS = join(ROOT_DIR, "node_modules/.bin/snarkjs")

// Powers of Tau config
const PTAU_SOURCES = {
    identity: {
        file: "powersOfTau28_hez_final_14.ptau",
        url: "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau",
        sha256: "489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d",
    },
    l2ps_16: {
        file: "powersOfTau28_hez_final_16.ptau",
        url: "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau",
    },
    l2ps_17: {
        file: "powersOfTau28_hez_final_17.ptau",
        url: "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau",
    },
}

// Terminal colors
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
}

function log(message: string, color: keyof typeof colors = "reset") {
    console.log(`${colors[color]}${message}${colors.reset}`)
}

function sectionLog(title: string) {
    log(`\n${"═".repeat(60)}`, "cyan")
    log(`  ${title}`, "cyan")
    log(`${"═".repeat(60)}`, "cyan")
}

function stepLog(step: number, total: number, message: string) {
    log(`\n[${step}/${total}] ${message}`, "blue")
}

function exec(command: string, description: string, cwd?: string) {
    try {
        log(`  → ${description}...`, "yellow")
        execSync(command, { stdio: "inherit", cwd: cwd || ROOT_DIR })
        log(`  ✓ ${description} complete`, "green")
    } catch (error) {
        log(`  ✗ ${description} failed`, "red")
        throw error
    }
}

function verifyPtauChecksum(filePath: string, expectedSha256?: string): boolean {
    if (!expectedSha256) return true // Skip verification if no checksum provided

    log("  → Verifying file integrity...", "yellow")
    try {
        const fileBuffer = readFileSync(filePath)
        const hash = createHash("sha256").update(fileBuffer).digest("hex")

        if (hash !== expectedSha256) {
            log("  ✗ Checksum mismatch!", "red")
            log(`    Expected: ${expectedSha256}`, "red")
            log(`    Got:      ${hash}`, "red")
            return false
        }

        log("  ✓ File integrity verified", "green")
        return true
    } catch (error) {
        log(`  ✗ Verification failed: ${error}`, "red")
        return false
    }
}

async function downloadPtau(config: { file: string; url: string; sha256?: string }, targetDir: string): Promise<boolean> {
    const ptauPath = join(targetDir, config.file)

    if (existsSync(ptauPath)) {
        log(`  ✓ ${config.file} already exists`, "green")
        if (config.sha256 && !verifyPtauChecksum(ptauPath, config.sha256)) {
            log("  ⚠ Existing file failed verification, re-downloading...", "yellow")
            unlinkSync(ptauPath)
        } else {
            return true
        }
    }

    log(`  → Downloading ${config.file}...`, "yellow")

    try {
        execSync(
            `curl -L --progress-bar --max-time 600 -o "${ptauPath}" "${config.url}"`,
            { stdio: "inherit", timeout: 600000 },
        )
        log(`  ✓ Downloaded ${config.file}`, "green")

        if (config.sha256 && !verifyPtauChecksum(ptauPath, config.sha256)) {
            unlinkSync(ptauPath)
            throw new Error("Downloaded file failed integrity verification")
        }

        return true
    } catch (error) {
        log(`  ✗ Download failed: ${error}`, "red")
        return false
    }
}

// ============================================================
// ZK IDENTITY SETUP
// ============================================================

async function setupZkIdentity(): Promise<boolean> {
    sectionLog("ZK Identity System Setup")

    const keysDir = join(ZK_IDENTITY_DIR, "keys")
    const circuitsDir = join(ZK_IDENTITY_DIR, "circuits")

    // Ensure directories
    mkdirSync(keysDir, { recursive: true })
    mkdirSync(circuitsDir, { recursive: true })

    // Step 1: Download Powers of Tau
    stepLog(1, 3, "Download Powers of Tau (Identity)")
    const ptauSuccess = await downloadPtau(PTAU_SOURCES.identity, keysDir)
    if (!ptauSuccess) {
        log("  ⚠ Failed to download Powers of Tau, skipping ZK Identity setup", "yellow")
        return false
    }

    // Step 2: Compile circuits
    stepLog(2, 3, "Compile Identity Circuits")
    const circuits = ["identity", "identity_with_merkle"]
    let compiledCircuit: string | null = null

    for (const circuit of circuits) {
        const circuitPath = join(circuitsDir, `${circuit}.circom`)
        if (existsSync(circuitPath)) {
            try {
                exec(
                    `circom2 ${circuitPath} --r1cs --wasm --sym -o ${circuitsDir}/ -l node_modules`,
                    `Compile ${circuit}.circom`,
                )
                compiledCircuit = circuit
            } catch (error) {
                log(`  ⚠ Failed to compile ${circuit}, trying next...`, "yellow")
            }
        } else {
            log(`  ⚠ ${circuit}.circom not found, skipping`, "yellow")
        }
    }

    // Step 3: Generate keys
    stepLog(3, 3, "Generate Proving and Verification Keys (Identity)")
    if (!compiledCircuit) {
        log("  ⚠ No circuits compiled, skipping key generation", "yellow")
        return false
    }

    const r1csPath = join(circuitsDir, `${compiledCircuit}.r1cs`)
    const ptauPath = join(keysDir, PTAU_SOURCES.identity.file)
    const zkeyPath0 = join(keysDir, `${compiledCircuit}_0000.zkey`)
    const zkeyPath1 = join(keysDir, `${compiledCircuit}_0001.zkey`)
    const vkeyPath = join(keysDir, compiledCircuit === "identity_with_merkle" ? "verification_key_merkle.json" : "verification_key.json")

    try {
        // Initial proving key
        exec(`${SNARKJS} groth16 setup ${r1csPath} ${ptauPath} ${zkeyPath0}`, "Generate initial proving key")

        // Add contribution
        const entropy = randomBytes(32).toString("hex")
        exec(`${SNARKJS} zkey contribute ${zkeyPath0} ${zkeyPath1} --name="ProductionContribution" -e="${entropy}"`, "Add random contribution")

        // Export verification key
        exec(`${SNARKJS} zkey export verificationkey ${zkeyPath1} ${vkeyPath}`, "Export verification key")

        log(`  ✓ ZK Identity setup complete: ${vkeyPath}`, "green")
        return true
    } catch (error) {
        log(`  ✗ Key generation failed: ${error}`, "red")
        return false
    }
}

// ============================================================
// L2PS ZK SETUP
// ============================================================

async function setupL2psZk(): Promise<boolean> {
    sectionLog("L2PS ZK System Setup")

    const keysDir = join(L2PS_ZK_DIR, "keys")
    const circuitsDir = join(L2PS_ZK_DIR, "circuits")
    const ptauDir = join(L2PS_ZK_DIR, "ptau")
    const circomlibPath = join(ROOT_DIR, "node_modules/circomlib/circuits")

    // Ensure directories
    mkdirSync(keysDir, { recursive: true })
    mkdirSync(ptauDir, { recursive: true })
    mkdirSync(join(keysDir, "batch_5"), { recursive: true })
    mkdirSync(join(keysDir, "batch_10"), { recursive: true })

    // Step 1: Download Powers of Tau files
    stepLog(1, 2, "Download Powers of Tau (L2PS)")
    await downloadPtau(PTAU_SOURCES.l2ps_16, ptauDir)
    await downloadPtau(PTAU_SOURCES.l2ps_17, ptauDir)

    // Step 2: Setup batch circuits
    stepLog(2, 2, "Compile and Setup L2PS Batch Circuits")

    const batchConfigs = [
        { size: 5, pot: 16 },
        { size: 10, pot: 17 },
    ]

    let anySuccess = false

    for (const { size, pot } of batchConfigs) {
        const circuit = `l2ps_batch_${size}`
        const circuitPath = join(circuitsDir, `${circuit}.circom`)
        const outputDir = join(keysDir, `batch_${size}`)
        const ptauPath = join(ptauDir, `powersOfTau28_hez_final_${pot}.ptau`)

        if (!existsSync(circuitPath)) {
            log(`  ⚠ ${circuit}.circom not found, skipping`, "yellow")
            continue
        }

        if (!existsSync(ptauPath)) {
            log(`  ⚠ pot${pot} not found, skipping batch_${size}`, "yellow")
            continue
        }

        try {
            log(`\n  Setting up batch_${size}...`, "cyan")

            // Compile circuit
            exec(
                `circom2 ${circuitPath} --r1cs --wasm --sym -o ${outputDir} -l ${circomlibPath}`,
                `Compile ${circuit}.circom`,
            )

            // Generate PLONK zkey
            exec(
                `${SNARKJS} plonk setup ${outputDir}/${circuit}.r1cs ${ptauPath} ${outputDir}/${circuit}.zkey`,
                `Generate PLONK zkey for batch_${size}`,
            )

            // Export verification key
            exec(
                `${SNARKJS} zkey export verificationkey ${outputDir}/${circuit}.zkey ${outputDir}/verification_key.json`,
                `Export verification key for batch_${size}`,
            )

            log(`  ✓ batch_${size} setup complete`, "green")
            anySuccess = true
        } catch (error) {
            log(`  ✗ batch_${size} setup failed: ${error}`, "red")
        }
    }

    return anySuccess
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    log("\n╔════════════════════════════════════════════════════════════╗", "blue")
    log("║     UNIFIED ZK SETUP - ZK Identity + L2PS                 ║", "blue")
    log("╚════════════════════════════════════════════════════════════╝", "blue")

    log("\nThis script will set up all ZK systems:", "yellow")
    log("  1. ZK Identity System - User identity attestations", "yellow")
    log("  2. L2PS ZK System - Private batch transactions", "yellow")

    const results = {
        identity: false,
        l2ps: false,
    }

    try {
        // Setup ZK Identity
        results.identity = await setupZkIdentity()

        // Setup L2PS ZK
        results.l2ps = await setupL2psZk()

        // Final summary
        log("\n╔════════════════════════════════════════════════════════════╗", "green")
        log("║                    SETUP COMPLETE                          ║", "green")
        log("╚════════════════════════════════════════════════════════════╝", "green")

        log("\n📊 Results:", "blue")
        log(`  ZK Identity:  ${results.identity ? "✓ Success" : "⚠ Partial/Failed"}`, results.identity ? "green" : "yellow")
        log(`  L2PS ZK:      ${results.l2ps ? "✓ Success" : "⚠ Partial/Failed"}`, results.l2ps ? "green" : "yellow")

        log("\n📁 Generated files:", "blue")
        log("  ZK Identity:  src/features/zk/keys/verification_key*.json", "yellow")
        log("  L2PS ZK:      src/libs/l2ps/zk/keys/batch_*/verification_key.json", "yellow")

        log("\n⚠️  Important:", "yellow")
        log("  - Commit verification_key*.json files to the repo", "yellow")
        log("  - DO NOT commit: .zkey, .ptau, .r1cs, .wasm, .sym files", "yellow")

    } catch (error) {
        log("\n╔════════════════════════════════════════════════════════════╗", "red")
        log("║                    SETUP FAILED                            ║", "red")
        log("╚════════════════════════════════════════════════════════════╝", "red")
        console.error(error)
        process.exit(1)
    }
}

main()
