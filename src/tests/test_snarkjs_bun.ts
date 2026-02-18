/**
 * Test snarkjs.groth16.verify with Bun
 * Checking if worker thread issue is resolved
 */

import * as snarkjs from "snarkjs"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

console.log("🧪 Testing snarkjs.groth16.verify with Bun\n")

async function testVerification() {
    try {
        console.log("📋 Loading verification key...")
        // REVIEW: Use import.meta.url for reliable path resolution independent of cwd
        const __filename = fileURLToPath(import.meta.url)
        const __dirname = dirname(__filename)
        const vKeyPath = join(__dirname, "../features/zk/keys/verification_key_merkle.json")
        const vKey = JSON.parse(readFileSync(vKeyPath, "utf-8"))
        console.log("✅ Verification key loaded\n")

        // REVIEW: Validate expected signal count from verification key
        const expectedSignalsCount = vKey.nPublic
        console.log(`📋 Expected public signals count: ${expectedSignalsCount}`)

        console.log("📋 Testing with invalid proof (should reject)...")
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

        // REVIEW: Generate public signals array with correct size based on vKey
        const publicSignals = Array.from({ length: expectedSignalsCount }, (_, i) =>
            (12345 + i * 55555).toString(),
        )

        console.log("🔍 Calling snarkjs.groth16.verify...")
        const isValid = await snarkjs.groth16.verify(vKey, publicSignals, invalidProof)

        console.log("✅ Verification completed without crash!")
        console.log(`   Result: ${isValid} (expected: false)`)

        if (!isValid) {
            console.log("\n✅ SUCCESS: snarkjs.groth16.verify works with Bun!")
            console.log("   Invalid proof was correctly rejected")
            return true
        } else {
            console.log("\n⚠️  WARNING: Invalid proof was accepted (should not happen)")
            return false
        }
    } catch (error) {
        console.log(`\n❌ FAILED: ${error}`)
        console.log(`   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`)
        if (error instanceof Error) {
            console.log(`   Message: ${error.message}`)
            console.log(`   Stack: ${error.stack?.split("\n")[0]}`)
        }
        return false
    }
}

// REVIEW: Add exit codes for CI/CD integration
testVerification().then(success => {
    if (success) {
        console.log("\n🎉 snarkjs works with Bun - no workarounds needed!")
        process.exit(0)
    } else {
        console.log("\n⚠️  snarkjs has issues with Bun - need workaround")
        process.exit(1)
    }
}).catch(error => {
    console.error("\n❌ Unexpected error:", error)
    process.exit(1)
})
