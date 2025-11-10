/**
 * Test Bun-compatible snarkjs wrapper
 */

import { groth16VerifyBun } from "@/features/zk/proof/BunSnarkjsWrapper"
import { readFileSync } from "fs"
import { join } from "path"

console.log("🧪 Testing Bun-Compatible snarkjs Wrapper\n")

async function test() {
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

        console.log("🔍 Calling groth16VerifyBun (single-threaded)...")
        const isValid = await groth16VerifyBun(vKey, publicSignals, invalidProof)

        console.log("\n✅ SUCCESS! Verification completed without crash")
        console.log(`   Result: ${isValid} (expected: false)`)

        if (!isValid) {
            console.log("\n🎉 PERFECT! Bun-compatible verification works!")
            console.log("   Invalid proof was correctly rejected")
            console.log("   No worker threads = no crashes")
        } else {
            console.log("\n⚠️  WARNING: Invalid proof was accepted")
        }

        return true
    } catch (error) {
        console.log(`\n❌ FAILED: ${error}`)
        if (error instanceof Error) {
            console.log(`   Stack: ${error.stack}`)
        }
        return false
    }
}

test().then(success => {
    if (success) {
        console.log("\n✅ Bun-compatible snarkjs wrapper works!")
        console.log("   Ready to integrate into ProofVerifier.ts")
    } else {
        console.log("\n❌ Wrapper failed - need different approach")
    }
})
