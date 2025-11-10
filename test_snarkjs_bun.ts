/**
 * Test snarkjs.groth16.verify with Bun
 * Checking if worker thread issue is resolved
 */

import * as snarkjs from "snarkjs"
import { readFileSync } from "fs"
import { join } from "path"

console.log("🧪 Testing snarkjs.groth16.verify with Bun\n")

async function testVerification() {
    try {
        console.log("📋 Loading verification key...")
        const vKeyPath = join(process.cwd(), "src/features/zk/keys/verification_key_merkle.json")
        const vKey = JSON.parse(readFileSync(vKeyPath, "utf-8"))
        console.log("✅ Verification key loaded\n")

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

        const publicSignals = ["12345", "67890", "11111"]

        console.log("🔍 Calling snarkjs.groth16.verify...")
        const isValid = await snarkjs.groth16.verify(vKey, publicSignals, invalidProof)

        console.log("✅ Verification completed without crash!")
        console.log(`   Result: ${isValid} (expected: false)`)

        if (!isValid) {
            console.log("\n✅ SUCCESS: snarkjs.groth16.verify works with Bun!")
            console.log("   Invalid proof was correctly rejected")
        } else {
            console.log("\n⚠️  WARNING: Invalid proof was accepted (should not happen)")
        }

        return true
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

testVerification().then(success => {
    if (success) {
        console.log("\n🎉 snarkjs works with Bun - no workarounds needed!")
    } else {
        console.log("\n⚠️  snarkjs has issues with Bun - need workaround")
    }
})
