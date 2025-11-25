#!/usr/bin/env tsx
/**
 * ZK-SNARK Trusted Setup Ceremony - Multi-Party Contribution System
 *
 * This script manages a multi-party trusted setup ceremony where multiple
 * participants contribute randomness to generate secure proving/verification keys.
 *
 * Security: Only ONE honest participant is needed for the keys to be secure.
 *
 * Commands:
 *   init      - Initialize ceremony (generates 0000.zkey)
 *   contribute - Add your contribution (auto-detects last key)
 *   finalize  - Finalize ceremony and export verification key (initiator only)
 *
 * Run with:
 *   bun run zk:ceremony init
 *   bun run zk:ceremony contribute
 *   bun run zk:ceremony finalize
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import { createHash, randomBytes } from "crypto"

// Ceremony configuration
const CEREMONY_DIR = "zk_ceremony"
const KEYS_DIR = join(CEREMONY_DIR, "keys")
const ATTESTATIONS_DIR = join(CEREMONY_DIR, "attestations")
const STATE_FILE = join(CEREMONY_DIR, "ceremony_state.json")
const CIRCUIT_NAME = "identity_with_merkle"
const R1CS_PATH = `src/features/zk/circuits/${CIRCUIT_NAME}.r1cs`
const PTAU_FILE = "src/features/zk/keys/powersOfTau28_hez_final_14.ptau"
const FINAL_VKEY_PATH = "src/features/zk/keys/verification_key_merkle.json"

// Terminal colors
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
}

interface CeremonyState {
    initiator: string // Name from publickey_ed25519_* file
    phase: "init" | "contributing" | "finalized"
    currentKey: number // Current highest key number
    contributors: Array<{
        name: string
        keyNumber: number
        timestamp: number
        attestationHash: string
    }>
    circuitName: string
    r1csHash: string // For verification
}

function log(message: string, color: keyof typeof colors = "reset") {
    console.log(`${colors[color]}${message}${colors.reset}`)
}

function error(message: string) {
    log(`✗ ${message}`, "red")
    process.exit(1)
}

function success(message: string) {
    log(`✓ ${message}`, "green")
}

function info(message: string) {
    log(`ℹ ${message}`, "cyan")
}

function warn(message: string) {
    log(`⚠ ${message}`, "yellow")
}

/**
 * REVIEW: Extract participant address from publickey_ed25519_* file
 * Ensures all participants are identified by their public key address
 * Format: publickey_ed25519_0x<address> (no extension)
 */
function getParticipantName(): string {
    // Find all publickey_ed25519_* files in root (no extension)
    const files = readdirSync(".")
        .filter(f => f.startsWith("publickey_ed25519_") && f !== "publickey_ed25519_")

    if (files.length === 0) {
        error("No publickey_ed25519_* file found in repository root!")
    }

    if (files.length > 1) {
        warn(`Multiple public key files found: ${files.join(", ")}`)
        warn(`Using first one: ${files[0]}`)
    }

    // Extract address from filename: publickey_ed25519_0x<address> -> 0x<address>
    const filename = files[0]
    const address = filename.replace(/^publickey_ed25519_/, "")

    if (!address || address === "publickey_ed25519_") {
        error(`Invalid public key filename format: ${filename}`)
    }

    return address
}

/**
 * REVIEW: Compute R1CS hash for ceremony verification
 */
function computeR1csHash(): string {
    if (!existsSync(R1CS_PATH)) {
        error(`R1CS file not found: ${R1CS_PATH}`)
    }

    const fileBuffer = readFileSync(R1CS_PATH)
    return createHash("sha256").update(fileBuffer).digest("hex")
}

/**
 * REVIEW: Load or initialize ceremony state
 */
function loadCeremonyState(): CeremonyState | null {
    if (!existsSync(STATE_FILE)) {
        return null
    }

    try {
        const content = readFileSync(STATE_FILE, "utf-8")
        return JSON.parse(content)
    } catch (error) {
        warn(`Failed to parse ceremony state: ${error}`)
        return null
    }
}

/**
 * REVIEW: Save ceremony state
 */
function saveCeremonyState(state: CeremonyState) {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

/**
 * REVIEW: Get path for ceremony key by number
 */
function getKeyPath(keyNumber: number): string {
    const paddedNumber = keyNumber.toString().padStart(4, "0")
    return join(KEYS_DIR, `ceremony_${paddedNumber}.zkey`)
}

/**
 * REVIEW: Get path for attestation file
 */
function getAttestationPath(keyNumber: number, name: string): string {
    const paddedNumber = keyNumber.toString().padStart(4, "0")
    return join(ATTESTATIONS_DIR, `${paddedNumber}_${name}.txt`)
}

/**
 * REVIEW: Compute attestation hash from zkey file
 */
function computeAttestationHash(zkeyPath: string): string {
    const fileBuffer = readFileSync(zkeyPath)
    return createHash("sha256").update(fileBuffer).digest("hex")
}

/**
 * REVIEW: Ensure ceremony directories exist
 */
function ensureCeremonyDirectories() {
    if (!existsSync(CEREMONY_DIR)) {
        mkdirSync(CEREMONY_DIR, { recursive: true })
    }
    if (!existsSync(KEYS_DIR)) {
        mkdirSync(KEYS_DIR, { recursive: true })
    }
    if (!existsSync(ATTESTATIONS_DIR)) {
        mkdirSync(ATTESTATIONS_DIR, { recursive: true })
    }
}

/**
 * Command: Initialize ceremony
 * Generates initial 0000.zkey from R1CS and Powers of Tau
 */
async function initCeremony() {
    log("\n╔════════════════════════════════════════════════════════════╗", "blue")
    log("║  ZK Ceremony - Initialize                                  ║", "blue")
    log("╚════════════════════════════════════════════════════════════╝", "blue")

    const participantName = getParticipantName()
    info(`Participant: ${participantName}`)

    // Check if ceremony already initialized
    const existingState = loadCeremonyState()
    if (existingState) {
        error(`Ceremony already initialized by ${existingState.initiator}!`)
    }

    // Ensure directories exist
    ensureCeremonyDirectories()

    // Verify R1CS exists
    if (!existsSync(R1CS_PATH)) {
        error(`R1CS file not found: ${R1CS_PATH}`)
    }

    // Verify Powers of Tau exists
    if (!existsSync(PTAU_FILE)) {
        error(`Powers of Tau file not found: ${PTAU_FILE}`)
    }

    const r1csHash = computeR1csHash()
    info(`Circuit: ${CIRCUIT_NAME}`)
    info(`R1CS hash: ${r1csHash.slice(0, 16)}...`)

    // Generate initial key (phase 0)
    const key0Path = getKeyPath(0)
    log("\n→ Generating initial proving key (phase 0)...", "yellow")

    try {
        execSync(
            `npx snarkjs groth16 setup ${R1CS_PATH} ${PTAU_FILE} ${key0Path}`,
            { stdio: "inherit" },
        )
        success("Initial key generated")
    } catch (error) {
        error("Failed to generate initial key")
    }

    // Compute attestation hash
    const attestationHash = computeAttestationHash(key0Path)
    const attestationPath = getAttestationPath(0, participantName)

    // Save attestation
    const attestation = `Ceremony Initialization
Participant: ${participantName}
Key: ceremony_0000.zkey
Circuit: ${CIRCUIT_NAME}
R1CS Hash: ${r1csHash}
Attestation Hash: ${attestationHash}
Timestamp: ${new Date().toISOString()}
`
    writeFileSync(attestationPath, attestation)
    success(`Attestation saved: ${attestationPath}`)

    // Save ceremony state
    const state: CeremonyState = {
        initiator: participantName,
        phase: "init",
        currentKey: 0,
        contributors: [
            {
                name: participantName,
                keyNumber: 0,
                timestamp: Date.now(),
                attestationHash,
            },
        ],
        circuitName: CIRCUIT_NAME,
        r1csHash,
    }
    saveCeremonyState(state)

    log("\n╔════════════════════════════════════════════════════════════╗", "green")
    log("║  ✓ Ceremony Initialized!                                   ║", "green")
    log("╚════════════════════════════════════════════════════════════╝", "green")

    info("\nNext steps:")
    info(`  1. Share the ${CEREMONY_DIR}/ folder with the next contributor`)
    info("  2. Next contributor runs: bun run zk:ceremony contribute")
    info("  3. After all contributions, initiator runs: bun run zk:ceremony finalize")
}

/**
 * Command: Contribute to ceremony
 * Auto-detects last key, adds contribution, generates next key
 */
async function contributeCeremony() {
    log("\n╔════════════════════════════════════════════════════════════╗", "blue")
    log("║  ZK Ceremony - Contribute                                  ║", "blue")
    log("╚════════════════════════════════════════════════════════════╝", "blue")

    const participantName = getParticipantName()
    info(`Participant: ${participantName}`)

    // Load ceremony state
    const state = loadCeremonyState()
    if (!state) {
        error("Ceremony not initialized! Run: bun run zk:ceremony init")
    }

    if (state.phase === "finalized") {
        error("Ceremony already finalized!")
    }

    // REVIEW: SECURITY - Prevent duplicate contributions to maintain independence
    const alreadyContributed = state.contributors.some(c => c.name === participantName)
    if (alreadyContributed) {
        error(`You (${participantName}) already contributed to this ceremony! Duplicate contributions are not allowed for security.`)
    }

    // Auto-detect last key
    const lastKeyNumber = state.currentKey
    const nextKeyNumber = lastKeyNumber + 1
    const inputKeyPath = getKeyPath(lastKeyNumber)
    const outputKeyPath = getKeyPath(nextKeyNumber)

    if (!existsSync(inputKeyPath)) {
        error(`Previous key not found: ${inputKeyPath}`)
    }

    info(`Input key: ceremony_${lastKeyNumber.toString().padStart(4, "0")}.zkey`)
    info(`Output key: ceremony_${nextKeyNumber.toString().padStart(4, "0")}.zkey`)

    // REVIEW: Generate cryptographically secure random entropy
    log("\n→ Generating secure random entropy...", "yellow")
    const entropy = randomBytes(32).toString("hex")
    success("Entropy generated (kept secret)")

    // Add contribution
    log(`→ Adding contribution from ${participantName}...`, "yellow")
    log("  This may take a minute...", "yellow")

    try {
        execSync(
            `npx snarkjs zkey contribute ${inputKeyPath} ${outputKeyPath} --name="${participantName}" -e="${entropy}"`,
            { stdio: "inherit" },
        )
        success("Contribution added successfully")
    } catch (error) {
        error("Failed to add contribution")
    }

    // Compute attestation hash
    const attestationHash = computeAttestationHash(outputKeyPath)
    const attestationPath = getAttestationPath(nextKeyNumber, participantName)

    // Save attestation
    const attestation = `Ceremony Contribution
Participant: ${participantName}
Key: ceremony_${nextKeyNumber.toString().padStart(4, "0")}.zkey
Input Key: ceremony_${lastKeyNumber.toString().padStart(4, "0")}.zkey
Circuit: ${state.circuitName}
Attestation Hash: ${attestationHash}
Timestamp: ${new Date().toISOString()}

IMPORTANT: Delete your local copy of this key after passing it to the next contributor!
This is the "toxic waste" that must be destroyed for security.
`
    writeFileSync(attestationPath, attestation)
    success(`Attestation saved: ${attestationPath}`)

    // Update ceremony state
    state.currentKey = nextKeyNumber
    state.phase = "contributing"
    state.contributors.push({
        name: participantName,
        keyNumber: nextKeyNumber,
        timestamp: Date.now(),
        attestationHash,
    })
    saveCeremonyState(state)

    log("\n╔════════════════════════════════════════════════════════════╗", "green")
    log("║  ✓ Contribution Complete!                                  ║", "green")
    log("╚════════════════════════════════════════════════════════════╝", "green")

    info("\nContributors so far:")
    state.contributors.forEach(c => {
        info(`  ${c.keyNumber.toString().padStart(4, "0")} - ${c.name}`)
    })

    info("\nNext steps:")
    info(`  1. Share the ${CEREMONY_DIR}/ folder with the next contributor`)
    info("  2. Next contributor runs: bun run zk:ceremony contribute")
    info("  3. OR if all contributions done, initiator runs: bun run zk:ceremony finalize")

    warn("\n⚠️  SECURITY: Delete your local zk_ceremony/ folder after sharing!")
    warn("⚠️  Keep only your attestation file as proof of participation.")
}

/**
 * Command: Finalize ceremony
 * Exports verification key from final contributed key (initiator only)
 */
async function finalizeCeremony() {
    log("\n╔════════════════════════════════════════════════════════════╗", "blue")
    log("║  ZK Ceremony - Finalize                                    ║", "blue")
    log("╚════════════════════════════════════════════════════════════╝", "blue")

    const participantName = getParticipantName()
    info(`Participant: ${participantName}`)

    // Load ceremony state
    const state = loadCeremonyState()
    if (!state) {
        error("Ceremony not initialized!")
    }

    // REVIEW: Only initiator can finalize
    if (state.initiator !== participantName) {
        error(`Only the initiator (${state.initiator}) can finalize the ceremony!`)
    }

    if (state.phase === "finalized") {
        error("Ceremony already finalized!")
    }

    const finalKeyPath = getKeyPath(state.currentKey)
    if (!existsSync(finalKeyPath)) {
        error(`Final key not found: ${finalKeyPath}`)
    }

    info(`Final key: ceremony_${state.currentKey.toString().padStart(4, "0")}.zkey`)
    info(`Contributors: ${state.contributors.length}`)

    // Export verification key
    log("\n→ Exporting verification key...", "yellow")

    try {
        execSync(
            `npx snarkjs zkey export verificationkey ${finalKeyPath} ${FINAL_VKEY_PATH}`,
            { stdio: "inherit" },
        )
        success("Verification key exported")
    } catch (error) {
        error("Failed to export verification key")
    }

    // Verify gamma ≠ delta (production safety check)
    log("→ Verifying production safety (gamma ≠ delta)...", "yellow")
    const vkContent = JSON.parse(readFileSync(FINAL_VKEY_PATH, "utf-8"))
    const gamma = JSON.stringify(vkContent.vk_gamma_2)
    const delta = JSON.stringify(vkContent.vk_delta_2)

    if (gamma === delta) {
        error("CRITICAL: gamma and delta are identical! Ceremony is NOT production-safe!")
    } else {
        success("Verified: gamma and delta are distinct (production-safe)")
    }

    // Update ceremony state
    state.phase = "finalized"
    saveCeremonyState(state)

    // Create final ceremony report
    const reportPath = join(CEREMONY_DIR, "CEREMONY_REPORT.md")
    const report = `# ZK-SNARK Trusted Setup Ceremony Report

## Circuit Information
- **Circuit**: ${state.circuitName}
- **R1CS Hash**: ${state.r1csHash}

## Ceremony Participants
${state.contributors.map((c, i) => `
### Contribution ${i}: ${c.name}
- Key Number: ${c.keyNumber.toString().padStart(4, "0")}
- Timestamp: ${new Date(c.timestamp).toISOString()}
- Attestation Hash: ${c.attestationHash}
`).join("\n")}

## Final Verification Key
- **Path**: ${FINAL_VKEY_PATH}
- **Gamma ≠ Delta**: ✓ Verified
- **Production Safe**: YES

## Security Guarantee
This ceremony involved ${state.contributors.length} participants. As long as ONE participant:
- Generated entropy securely
- Deleted their intermediate key after contribution

The final keys are cryptographically secure and cannot be forged.

## Attestations
Individual attestations are available in: ${ATTESTATIONS_DIR}/

---
*Generated: ${new Date().toISOString()}*
*Initiator: ${state.initiator}*
*Finalized by: ${participantName}*
`
    writeFileSync(reportPath, report)
    success(`Ceremony report saved: ${reportPath}`)

    log("\n╔════════════════════════════════════════════════════════════╗", "green")
    log("║  ✓ Ceremony Finalized!                                     ║", "green")
    log("╚════════════════════════════════════════════════════════════╝", "green")

    info("\nCeremony Summary:")
    info(`  Contributors: ${state.contributors.length}`)
    info(`  Verification Key: ${FINAL_VKEY_PATH}`)
    info(`  Report: ${reportPath}`)

    info("\nNext steps:")
    warn("\n⚠️  CRITICAL: Update CDN files FIRST before anything else!")
    info("  1. Rename final key for CDN upload:")
    info(`     cp ${finalKeyPath} identity_with_merkle_0000.zkey`)
    info("  2. Upload to CDN (REQUIRED for SDK to work):")
    info("     - identity_with_merkle_0000.zkey → https://files.demos.sh/zk-circuits/v1/")
    info("     - verification_key_merkle.json → https://files.demos.sh/zk-circuits/v1/")
    info("  3. Commit verification_key_merkle.json to repository")
    info("     git add src/features/zk/keys/verification_key_merkle.json")
    info("  4. Commit ceremony report for transparency")
    info(`     git add ${reportPath}`)
    info("  5. All participants should DELETE their zk_ceremony/ folders")
    info("  6. Keep attestations for proof of participation")

    warn("\n⚠️  DO NOT commit the zk_ceremony/ folder - it's gitignored for security!")
    warn("⚠️  Until CDN is updated, SDK will use old keys and proofs will FAIL!")
}

/**
 * Main command dispatcher
 */
async function main() {
    const command = process.argv[2]

    switch (command) {
        case "init":
            await initCeremony()
            break
        case "contribute":
            await contributeCeremony()
            break
        case "finalize":
            await finalizeCeremony()
            break
        default:
            log("\nZK-SNARK Trusted Setup Ceremony", "cyan")
            log("═══════════════════════════════════\n", "cyan")
            log("Usage:", "yellow")
            log("  bun run zk:ceremony init       - Initialize ceremony (generates 0000.zkey)", "reset")
            log("  bun run zk:ceremony contribute - Add your contribution (auto-detects last key)", "reset")
            log("  bun run zk:ceremony finalize   - Finalize and export verification key (initiator only)", "reset")
            log("\nProcess:", "yellow")
            log("  1. Initiator runs 'init'", "reset")
            log("  2. Each participant runs 'contribute' (in sequence)", "reset")
            log("  3. Initiator runs 'finalize' (when all done)", "reset")
            log("\nSecurity:", "yellow")
            log("  - Only ONE honest participant is needed for security", "reset")
            log("  - Each participant MUST delete their zk_ceremony/ folder after contributing", "reset")
            log("  - Participant identity is extracted from publickey_ed25519_* file", "reset")
            process.exit(1)
    }
}

main().catch(error => {
    log(`\nError: ${error.message}`, "red")
    process.exit(1)
})
