/**
 * Identity Circuit Verification Test (Phase 3 - No Merkle Proof)
 *
 * Tests proof verification with the basic identity circuit.
 * This tests both invalid rejection and valid acceptance.
 */

import { groth16VerifyBun } from "@/features/zk/proof/BunSnarkjsWrapper"
import { readFileSync } from "fs"
import { join } from "path"

console.log("🧪 Testing Identity Circuit Verification (Phase 3)\n")

async function test() {
    let test1Passed = false
    let test2Passed = false

    try {
        // Load verification key for identity circuit
        // REVIEW: Use import.meta.url for reliable path resolution (not process.cwd())
        const vKeyPath = new URL("../features/zk/keys/verification_key.json", import.meta.url).pathname
        const vKey = JSON.parse(readFileSync(vKeyPath, "utf-8"))
        console.log("✅ Identity verification key loaded\n")

        // ============================================================
        // Test 1: Invalid Proof Rejection
        // ============================================================
        console.log("📋 Test 1: Invalid Proof Rejection")

        const invalidProof = {
            pi_a: ["1", "2", "1"],
            pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
            pi_c: ["1", "2", "1"],
            protocol: "groth16",
        }

        const invalidSignals = [
            "12345", // commitment
            "67890", // nullifier
            "11111", // context
        ]

        const isInvalid = await groth16VerifyBun(vKey, invalidSignals, invalidProof)
        console.log(`   Result: ${isInvalid}`)
        console.log(`   ${!isInvalid ? "✅" : "❌"} Invalid proof correctly rejected`)

        test1Passed = !isInvalid

        // ============================================================
        // Test 2: Valid Proof Acceptance
        // ============================================================
        console.log("\n📋 Test 2: Valid Proof Acceptance")
        console.log("   Loading valid proof fixture...")

        // REVIEW: Use import.meta.url for reliable path resolution (not process.cwd())
        const fixturePath = new URL("./fixtures/valid_proof_fixture.json", import.meta.url).pathname
        const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"))

        console.log(`   Loaded proof with ${fixture.publicSignals.length} public signals`)
        console.log(`   - commitment: ${fixture.publicSignals[0].slice(0, 20)}...`)
        console.log(`   - nullifier: ${fixture.publicSignals[1].slice(0, 20)}...`)
        console.log(`   - context: ${fixture.publicSignals[2]}`)

        const isValid = await groth16VerifyBun(vKey, fixture.publicSignals, fixture.proof)
        console.log(`\n   Result: ${isValid}`)
        console.log(`   ${isValid ? "✅" : "❌"} Valid proof correctly accepted`)

        test2Passed = isValid

        // ============================================================
        // Summary
        // ============================================================
        if (test1Passed && test2Passed) {
            console.log("\n✅ IDENTITY CIRCUIT VERIFICATION COMPLETE!")
            console.log("   ✅ Invalid proof rejected")
            console.log("   ✅ Valid proof accepted")
            console.log("   ✅ Both positive and negative test cases passing")
            return true
        } else {
            console.log("\n⚠️  WARNING: Some tests failed")
            console.log(`   Test 1 (Invalid Rejection): ${test1Passed ? "✅" : "❌"}`)
            console.log(`   Test 2 (Valid Acceptance): ${test2Passed ? "✅" : "❌"}`)
            return false
        }
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
        console.log("\n🎉 All identity circuit tests passing!")
    } else {
        console.log("\n❌ Identity circuit tests failed")
        process.exit(1)
    }
})
