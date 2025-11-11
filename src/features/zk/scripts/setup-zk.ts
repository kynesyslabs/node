#!/usr/bin/env tsx
/**
 * ZK-SNARK Identity System - Complete Setup Script
 *
 * This script handles the entire ZK setup process:
 * 1. Downloads Powers of Tau ceremony file
 * 2. Compiles Circom circuits
 * 3. Generates proving and verification keys
 *
 * Run with: bun run zk:setup-all
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import { createHash } from "crypto"

const KEYS_DIR = "src/features/zk/keys"
const CIRCUITS_DIR = "src/features/zk/circuits"
const PTAU_FILE = "powersOfTau28_hez_final_14.ptau"
const PTAU_URL = "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau"
// REVIEW: SHA-256 checksum of the official Powers of Tau file for supply chain security
const PTAU_SHA256 = "489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d"

// Terminal colors
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
}

function log(message: string, color: keyof typeof colors = "reset") {
    console.log(`${colors[color]}${message}${colors.reset}`)
}

function stepLog(step: number, total: number, message: string) {
    log(`\n[${step}/${total}] ${message}`, "blue")
}

function exec(command: string, description: string) {
    try {
        log(`  → ${description}...`, "yellow")
        execSync(command, { stdio: "inherit" })
        log(`  ✓ ${description} complete`, "green")
    } catch (error) {
        log(`  ✗ ${description} failed`, "red")
        throw error
    }
}

// REVIEW: Verify Powers of Tau file integrity for supply chain security
function verifyPtauChecksum(filePath: string): boolean {
    log("  → Verifying file integrity...", "yellow")

    try {
        const fileBuffer = readFileSync(filePath)
        const hash = createHash("sha256").update(fileBuffer).digest("hex")

        if (hash !== PTAU_SHA256) {
            log("  ✗ Checksum mismatch!", "red")
            log(`    Expected: ${PTAU_SHA256}`, "red")
            log(`    Got:      ${hash}`, "red")
            log("    The downloaded file may be corrupted or tampered with.", "red")
            return false
        }

        log("  ✓ File integrity verified", "green")
        return true
    } catch (error) {
        log(`  ✗ Verification failed: ${error}`, "red")
        return false
    }
}

async function downloadPowersOfTau() {
    const ptauPath = join(KEYS_DIR, PTAU_FILE)

    if (existsSync(ptauPath)) {
        log("  ✓ Powers of Tau file already exists", "green")
        // REVIEW: Verify existing file integrity
        if (!verifyPtauChecksum(ptauPath)) {
            log("  ⚠ Existing file failed verification, re-downloading...", "yellow")
            // REVIEW: HIGH FIX - Use Node.js unlinkSync for cross-platform compatibility
            unlinkSync(ptauPath)
        } else {
            return
        }
    }

    log("  → Downloading Powers of Tau ceremony file (~140MB)...", "yellow")
    log("    This is a one-time download from public Hermez ceremony", "yellow")

    try {
        // REVIEW: Using curl with progress bar and 5-minute timeout for cross-platform compatibility
        // Check curl availability first
        try {
            execSync("curl --version", { stdio: "ignore" })
        } catch {
            log("  ✗ curl not found. Please install curl first.", "red")
            throw new Error("curl not found. Install curl or download manually.")
        }

        execSync(
            `curl -L --progress-bar --max-time 300 -o "${ptauPath}" "${PTAU_URL}"`,
            { stdio: "inherit", timeout: 300000 },
        )
        log("  ✓ Powers of Tau downloaded successfully", "green")

        // REVIEW: Verify downloaded file integrity for supply chain security
        if (!verifyPtauChecksum(ptauPath)) {
            // REVIEW: HIGH FIX - Use Node.js unlinkSync for cross-platform compatibility
            unlinkSync(ptauPath)
            throw new Error("Downloaded file failed integrity verification")
        }
    } catch (error) {
        log("  ✗ Download failed", "red")
        log("    You can manually download from:", "yellow")
        log(`    ${PTAU_URL}`, "yellow")
        log(`    And place it in: ${KEYS_DIR}/`, "yellow")
        throw error
    }
}

function compileCircuit(circuitName: string) {
    const circuitPath = join(CIRCUITS_DIR, `${circuitName}.circom`)

    if (!existsSync(circuitPath)) {
        log(`  ⚠ Circuit ${circuitName}.circom not found, skipping compilation`, "yellow")
        log("    This is normal if you haven't created the circuit yet (Phase 3)", "yellow")
        return false
    }

    exec(
        `circom2 ${circuitPath} --r1cs --wasm --sym -o ${CIRCUITS_DIR}/ -l node_modules`,
        `Compiling ${circuitName}.circom`,
    )

    return true
}

async function generateKeys(circuitName: string) {
    const r1csPath = join(CIRCUITS_DIR, `${circuitName}.r1cs`)
    const ptauPath = join(KEYS_DIR, PTAU_FILE)
    const zkeyPath = join(KEYS_DIR, `${circuitName}_0000.zkey`)
    const vkeyPath = join(KEYS_DIR, "verification_key.json")

    if (!existsSync(r1csPath)) {
        log("  ⚠ R1CS file not found, skipping key generation", "yellow")
        return
    }

    if (!existsSync(ptauPath)) {
        log(`  ✗ Powers of Tau file not found at: ${ptauPath}`, "red")
        throw new Error("Powers of Tau file missing")
    }

    // Generate proving key
    log("  → Generating proving key (this may take 10-30 seconds)...", "yellow")
    try {
        execSync(
            `npx snarkjs groth16 setup ${r1csPath} ${ptauPath} ${zkeyPath}`,
            { stdio: "inherit" },
        )
        log("  ✓ Proving key generated", "green")
    } catch (error) {
        log("  ✗ Proving key generation failed", "red")
        throw error
    }

    // Export verification key
    log("  → Exporting verification key...", "yellow")
    try {
        execSync(
            `npx snarkjs zkey export verificationkey ${zkeyPath} ${vkeyPath}`,
            { stdio: "inherit" },
        )
        log("  ✓ Verification key exported", "green")
        log(`    → ${vkeyPath}`, "green")
        log("    ⚠ FOR CIRCUIT DEVELOPERS: Commit verification_key.json to repo (ONE TIME)", "yellow")
        log("    ⚠ FOR VALIDATORS: Use the verification_key.json from the repo (DO NOT commit your own)", "yellow")
    } catch (error) {
        log("  ✗ Verification key export failed", "red")
        throw error
    }
}

async function main() {
    log("\n╔════════════════════════════════════════════════════════════╗", "blue")
    log("║  ZK-SNARK Identity System - Complete Setup                ║", "blue")
    log("╚════════════════════════════════════════════════════════════╝", "blue")

    // Ensure directories exist
    if (!existsSync(KEYS_DIR)) {
        mkdirSync(KEYS_DIR, { recursive: true })
    }
    if (!existsSync(CIRCUITS_DIR)) {
        mkdirSync(CIRCUITS_DIR, { recursive: true })
    }

    try {
        // Step 1: Download Powers of Tau
        stepLog(1, 3, "Download Powers of Tau Ceremony File")
        await downloadPowersOfTau()

        // Step 2: Compile circuits
        stepLog(2, 3, "Compile Circom Circuits")

        // REVIEW: Track compilation results for accurate key generation logic
        // Try basic circuit first
        const basicCompiled = compileCircuit("identity")

        // Try Merkle circuit (Phase 5)
        const merkleCompiled = compileCircuit("identity_with_merkle")

        // Step 3: Generate keys
        stepLog(3, 3, "Generate Proving and Verification Keys")

        // REVIEW: Use compilation results instead of file existence to avoid stale R1CS
        if (merkleCompiled) {
            await generateKeys("identity_with_merkle")
        } else if (basicCompiled) {
            await generateKeys("identity")
        } else {
            log("  ⚠ No circuits compiled successfully", "yellow")
            log("    Create circuit files in src/features/zk/circuits/ first", "yellow")
        }

        // Success summary
        log("\n╔════════════════════════════════════════════════════════════╗", "green")
        log("║  ✓ ZK Setup Complete!                                      ║", "green")
        log("╚════════════════════════════════════════════════════════════╝", "green")

        log("\nNext steps:", "blue")
        log("  1. If verification_key.json was generated, commit it to the repo", "yellow")
        log("  2. Add verification_key.json to git: git add src/features/zk/keys/verification_key.json", "yellow")
        log("  3. DO NOT commit: .zkey or .ptau files (they are gitignored)", "yellow")
        log("\nFor development:", "blue")
        log("  - Edit circuits: src/features/zk/circuits/", "yellow")
        log("  - Re-run setup: bun run zk:setup-all", "yellow")

    } catch (error) {
        log("\n╔════════════════════════════════════════════════════════════╗", "red")
        log("║  ✗ ZK Setup Failed                                         ║", "red")
        log("╚════════════════════════════════════════════════════════════╝", "red")
        log("\nError details:", "red")
        console.error(error)
        process.exit(1)
    }
}

main()
