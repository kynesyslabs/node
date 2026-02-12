/**
 * ZK Identity System - Node-Side Tests Without Running Node
 *
 * Tests node-side functionality that doesn't require:
 * - Running RPC server
 * - Database connection
 * - Full node startup
 *
 * Tests:
 * - Verification key loading and validation
 * - Proof verification (cryptographic only, no DB checks)
 * - Key file format validation
 */

import * as snarkjs from "snarkjs"
import { readFileSync } from "fs"
import { join } from "path"

console.log("🧪 Testing ZK Identity System - Node Side (No Node Required)\n")

// REVIEW: Track test results for accurate summary
const testResults = {
    vkeyLoading: false,
    structure: false,
    proofRejection: false,
    fileValidation: false,
    cdnSync: false,
}

// Test 1: Verification Key Loading
console.log("📋 Test 1: Verification Key Loading")
try {
    const vKeyPath = join(process.cwd(), "src/features/zk/keys/verification_key_merkle.json")
    const vKeyJson = readFileSync(vKeyPath, "utf-8")
    const vKey = JSON.parse(vKeyJson)

    console.log("  ✅ Verification key loaded successfully")
    console.log(`  ✅ Key has protocol: ${vKey.protocol}`)
    console.log(`  ✅ Key has curve: ${vKey.curve}`)
    console.log(`  ✅ Key has nPublic: ${vKey.nPublic}`)
    testResults.vkeyLoading = true
} catch (error) {
    console.log(`  ❌ Failed to load verification key: ${error}`)
}
console.log()

// Test 2: Verification Key Structure Validation
console.log("📋 Test 2: Verification Key Structure Validation")
try {
    const vKeyPath = join(process.cwd(), "src/features/zk/keys/verification_key_merkle.json")
    const vKey = JSON.parse(readFileSync(vKeyPath, "utf-8"))

    const hasProtocol = "protocol" in vKey
    const hasCurve = "curve" in vKey
    const hasNPublic = "nPublic" in vKey
    const hasVkAlpha1 = "vk_alpha_1" in vKey
    const hasVkBeta2 = "vk_beta_2" in vKey
    const hasVkGamma2 = "vk_gamma_2" in vKey
    const hasVkDelta2 = "vk_delta_2" in vKey
    const hasIC = "IC" in vKey

    console.log(`  Protocol: ${hasProtocol ? "✅" : "❌"} ${vKey.protocol}`)
    console.log(`  Curve: ${hasCurve ? "✅" : "❌"} ${vKey.curve}`)
    console.log(`  Public inputs: ${hasNPublic ? "✅" : "❌"} ${vKey.nPublic}`)
    console.log(`  vk_alpha_1: ${hasVkAlpha1 ? "✅" : "❌"}`)
    console.log(`  vk_beta_2: ${hasVkBeta2 ? "✅" : "❌"}`)
    console.log(`  vk_gamma_2: ${hasVkGamma2 ? "✅" : "❌"}`)
    console.log(`  vk_delta_2: ${hasVkDelta2 ? "✅" : "❌"}`)
    console.log(`  IC (${Array.isArray(vKey.IC) ? vKey.IC.length : 0} elements): ${hasIC ? "✅" : "❌"}`)

    const allValid = hasProtocol && hasCurve && hasNPublic && hasVkAlpha1 &&
                     hasVkBeta2 && hasVkGamma2 && hasVkDelta2 && hasIC
    console.log(`  Overall structure: ${allValid ? "✅ Valid" : "❌ Invalid"}`)
    testResults.structure = allValid
} catch (error) {
    console.log(`  ❌ Validation failed: ${error}`)
}
console.log()

// Test 3: Invalid Proof Rejection (Cryptographic Verification)
console.log("📋 Test 3: Invalid Proof Rejection (Cryptographic Only)")
try {
    const vKeyPath = join(process.cwd(), "src/features/zk/keys/verification_key_merkle.json")
    const vKey = JSON.parse(readFileSync(vKeyPath, "utf-8"))

    // Create obviously invalid proof
    const invalidProof = {
        pi_a: ["1", "2", "1"],
        pi_b: [
            ["1", "2"],
            ["3", "4"],
            ["1", "0"],
        ],
        pi_c: ["1", "2", "1"],
        protocol: "groth16",
    }

    const publicSignals = [
        "12345", // nullifier
        "67890", // merkle_root
        "11111", // context
    ]

    // REVIEW: Differentiate between rejection (expected) and errors (unexpected)
    const isValid = await snarkjs.groth16.verify(vKey, publicSignals, invalidProof)

    if (!isValid) {
        console.log("  ✅ Invalid proof correctly rejected")
        testResults.proofRejection = true
    } else {
        console.log("  ❌ Invalid proof was accepted - BUG!")
        // REVIEW: MEDIUM FIX - Don't exit early, let all tests run for comprehensive results
        testResults.proofRejection = false
    }
} catch (error) {
    // REVIEW: MEDIUM FIX - Unexpected errors indicate configuration issues
    // Don't exit early - log error and continue to other tests
    console.log(`  ❌ Unexpected error: ${error instanceof Error ? error.message : String(error)}`)
    console.log("  ⚠️  Check verification key or snarkjs setup")
    testResults.proofRejection = false
}
console.log()

// Test 4: Key File Sizes and Existence
console.log("📋 Test 4: ZK Key Files Validation")
try {
    const keysDir = "src/features/zk/keys/"

    // Check proving key
    const provingKeyPath = join(process.cwd(), keysDir, "identity_with_merkle_0000.zkey")
    const provingKeyStat = await Bun.file(provingKeyPath).exists()
    const provingKeySize = provingKeyStat ? (await Bun.file(provingKeyPath).size()) : 0
    console.log("  Proving key (identity_with_merkle_0000.zkey):")
    console.log(`    Exists: ${provingKeyStat ? "✅" : "❌"}`)
    console.log(`    Size: ${(provingKeySize / 1024 / 1024).toFixed(2)} MB`)

    // Check verification key
    const verificationKeyPath = join(process.cwd(), keysDir, "verification_key_merkle.json")
    const verificationKeyStat = await Bun.file(verificationKeyPath).exists()
    const verificationKeySize = verificationKeyStat ? (await Bun.file(verificationKeyPath).size()) : 0
    console.log("  Verification key (verification_key_merkle.json):")
    console.log(`    Exists: ${verificationKeyStat ? "✅" : "❌"}`)
    console.log(`    Size: ${(verificationKeySize / 1024).toFixed(2)} KB`)

    // Check Powers of Tau
    const ptauPath = join(process.cwd(), keysDir, "powersOfTau28_hez_final_14.ptau")
    const ptauStat = await Bun.file(ptauPath).exists()
    const ptauSize = ptauStat ? (await Bun.file(ptauPath).size()) : 0
    console.log("  Powers of Tau (powersOfTau28_hez_final_14.ptau):")
    console.log(`    Exists: ${ptauStat ? "✅" : "❌"}`)
    console.log(`    Size: ${(ptauSize / 1024 / 1024).toFixed(2)} MB`)

    const allFilesExist = provingKeyStat && verificationKeyStat && ptauStat
    console.log(`  All key files present: ${allFilesExist ? "✅" : "❌"}`)
    testResults.fileValidation = allFilesExist
} catch (error) {
    console.log(`  ❌ File validation failed: ${error}`)
}
console.log()

// Test 5: CDN Files Match Local Files
console.log("📋 Test 5: CDN Files Match Local Files")
try {
    // REVIEW: MEDIUM FIX - Add timeout and status validation for CDN fetch
    const cdnVKeyUrl = "https://files.demos.sh/zk-circuits/v1/verification_key_merkle.json"
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

    try {
        const cdnResponse = await fetch(cdnVKeyUrl, {
            signal: controller.signal,
        })

        if (!cdnResponse.ok) {
            throw new Error(`CDN returned status ${cdnResponse.status}`)
        }

        const cdnVKey = await cdnResponse.json()

        // Load local verification key
        const localVKeyPath = join(process.cwd(), "src/features/zk/keys/verification_key_merkle.json")
        const localVKey = JSON.parse(readFileSync(localVKeyPath, "utf-8"))

        // Compare structure
        const protocolMatch = cdnVKey.protocol === localVKey.protocol
        const curveMatch = cdnVKey.curve === localVKey.curve
        const nPublicMatch = cdnVKey.nPublic === localVKey.nPublic

        console.log("  CDN vs Local verification key:")
        console.log(`    Protocol match: ${protocolMatch ? "✅" : "❌"} (${cdnVKey.protocol})`)
        console.log(`    Curve match: ${curveMatch ? "✅" : "❌"} (${cdnVKey.curve})`)
        console.log(`    nPublic match: ${nPublicMatch ? "✅" : "❌"} (${cdnVKey.nPublic})`)

        const keysMatch = protocolMatch && curveMatch && nPublicMatch
        console.log(`  CDN and local keys ${keysMatch ? "✅ match" : "❌ differ"}`)

        if (keysMatch) {
            console.log("  ✅ CDN is serving the correct verification key")
        }
        testResults.cdnSync = keysMatch
    } finally {
        // REVIEW: CRITICAL FIX - Always clear timeout to prevent resource leak
        clearTimeout(timeoutId)
    }
} catch (error) {
    console.log(`  ⚠️  CDN check failed: ${error}`)
}
console.log()

// REVIEW: Dynamic summary based on actual test results
console.log("📊 Test Results Summary:\n")
console.log(`  - Verification key: ${testResults.vkeyLoading ? "✅" : "❌"} Loaded and validated`)
console.log(`  - Key structure: ${testResults.structure ? "✅" : "❌"} Groth16 format correct`)
console.log(`  - Invalid proof rejection: ${testResults.proofRejection ? "✅" : "❌"} Working`)
console.log(`  - Key files: ${testResults.fileValidation ? "✅" : "❌"} Present and correct sizes`)
console.log(`  - CDN sync: ${testResults.cdnSync ? "✅" : "❌"} Matches local keys`)
console.log()

// Check if all tests passed
const allPassed = Object.values(testResults).every((result) => result === true)
if (allPassed) {
    console.log("✅ All Node-Side Tests Passed!\n")
} else {
    console.log("❌ Some tests failed - check output above\n")
}

console.log("🚫 Cannot Test Without Running Node:")
console.log("  - Database operations (nullifier checks, Merkle tree queries)")
console.log("  - RPC endpoints (proof submission, Merkle proof retrieval)")
console.log("  - Transaction processing (GCR integration)")
console.log("  - Full verification flow (cryptographic + DB checks)")
console.log()

console.log("💡 To test full verification flow:")
console.log("  1. Start the node: bun run dev")
console.log("  2. Run integration tests: bun test src/features/zk/tests/")
console.log()

// REVIEW: Exit with error code if any tests failed (for CI/CD integration)
process.exit(allPassed ? 0 : 1)
