/**
 * Bun-Compatible snarkjs Wrapper
 *
 * PROBLEM: snarkjs.groth16.verify uses worker threads by default,
 *          which crashes on Bun due to worker thread bugs
 *
 * SOLUTION: Direct implementation using snarkjs internals with singleThread mode
 *
 * This module provides a Bun-compatible groth16.verify that:
 * - Uses single-threaded curve operations (no workers)
 * - Maintains full cryptographic security
 * - Works identically to snarkjs.groth16.verify
 */

/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// NOTE: Variable names use snake_case to match ZK-SNARK cryptographic notation
// (pi_a, pi_b, pi_c, vk_alpha_1, etc. are standard Groth16 protocol names)

import { Scalar, utils, getCurveFromName } from "ffjavascript"
// REVIEW: HIGH FIX - Use public API instead of internal snarkjs import
// Previous: import * as curves from "node_modules/snarkjs/src/curves.js"
// Now using: getCurveFromName from ffjavascript public API

const { unstringifyBigInts } = utils

export interface ZKProof {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
    protocol: string
}

/**
 * Verify a Groth16 proof (Bun-compatible, single-threaded)
 *
 * @param vk_verifier - Verification key
 * @param publicSignals - Public signals array
 * @param proof - Groth16 proof object
 * @returns True if proof is valid
 */
export async function groth16VerifyBun(
    _vk_verifier: any,
    _publicSignals: any[],
    _proof: ZKProof,
): Promise<boolean> {
    let curve: any = null
    try {
        const vk_verifier = unstringifyBigInts(_vk_verifier)
        const proof = unstringifyBigInts(_proof)
        const publicSignals = unstringifyBigInts(_publicSignals)

        // REVIEW: Validate verification key structure to prevent cryptic errors
        if (!vk_verifier.curve || !Array.isArray(vk_verifier.IC) || vk_verifier.IC.length === 0 ||
            !vk_verifier.vk_alpha_1 || !vk_verifier.vk_beta_2 || !vk_verifier.vk_gamma_2 || !vk_verifier.vk_delta_2) {
            console.error("ZK Verify: Invalid verification key structure - missing or invalid IC (must be non-empty array) or other required fields")
            return false
        }

        // REVIEW: Validate curve is supported
        const SUPPORTED_CURVES = ["bn128", "bls12381"]
        if (!SUPPORTED_CURVES.includes(vk_verifier.curve)) {
            console.error(`ZK Verify: Unsupported curve ${vk_verifier.curve}`)
            return false
        }

        // REVIEW: Validate proof protocol is groth16
        if (proof.protocol && proof.protocol !== "groth16") {
            console.error(`ZK Verify: Unsupported protocol ${proof.protocol} (expected groth16)`)
            return false
        }

        // REVIEW: HIGH FIX - Use public API (getCurveFromName from ffjavascript)
        // CRITICAL: Pass singleThread: true to avoid worker threads
        curve = await getCurveFromName(vk_verifier.curve, true)

        // REVIEW: Validate curve initialization succeeded
        if (!curve || !curve.G1 || !curve.G2) {
            console.error(`ZK Verify: Failed to initialize curve ${vk_verifier.curve}`)
            return false
        }

        const IC0 = curve.G1.fromObject(vk_verifier.IC[0])

        // Validate IC length matches public signals
        if (vk_verifier.IC.length !== publicSignals.length + 1) {
            console.error("ZK Verify: IC length mismatch with public signals")
            return false
        }

        // REVIEW: Validate reasonable bounds on public signals to prevent DoS
        // Adjust MAX_PUBLIC_SIGNALS based on circuit requirements (typical: 2-10 signals)
        const MAX_PUBLIC_SIGNALS = 1024
        if (!Array.isArray(publicSignals) || publicSignals.length > MAX_PUBLIC_SIGNALS) {
            console.error(`ZK Verify: Public signals length ${publicSignals.length} exceeds maximum ${MAX_PUBLIC_SIGNALS}`)
            return false
        }

        const IC = new Uint8Array(curve.G1.F.n8 * 2 * publicSignals.length)
        const w = new Uint8Array(curve.Fr.n8 * publicSignals.length)

        // Validate public inputs
        if (!publicInputsAreValid(curve, publicSignals)) {
            console.error("ZK Verify: Public inputs are not valid")
            return false
        }

        // Build the public input linear combination
        for (let i = 0; i < publicSignals.length; i++) {
            const buffP = curve.G1.fromObject(vk_verifier.IC[i + 1])
            IC.set(buffP, i * curve.G1.F.n8 * 2)
            Scalar.toRprLE(w, curve.Fr.n8 * i, publicSignals[i], curve.Fr.n8)
        }

        let cpub = await curve.G1.multiExpAffine(IC, w)
        cpub = curve.G1.add(cpub, IC0)

        const pi_a = curve.G1.fromObject(proof.pi_a)
        const pi_b = curve.G2.fromObject(proof.pi_b)
        const pi_c = curve.G1.fromObject(proof.pi_c)

        if (!isWellConstructed(curve, { pi_a, pi_b, pi_c })) {
            console.error("ZK Verify: Proof commitments are not valid")
            return false
        }

        const vk_gamma_2 = curve.G2.fromObject(vk_verifier.vk_gamma_2)
        const vk_delta_2 = curve.G2.fromObject(vk_verifier.vk_delta_2)
        const vk_alpha_1 = curve.G1.fromObject(vk_verifier.vk_alpha_1)
        const vk_beta_2 = curve.G2.fromObject(vk_verifier.vk_beta_2)

        // Pairing check: e(pi_a, pi_b) = e(cpub, vk_gamma_2) * e(pi_c, vk_delta_2) * e(vk_alpha_1, vk_beta_2)
        const res = await curve.pairingEq(
            curve.G1.neg(pi_a),
            pi_b,
            cpub,
            vk_gamma_2,
            pi_c,
            vk_delta_2,
            vk_alpha_1,
            vk_beta_2,
        )

        if (!res) {
            console.error("ZK Verify: Invalid proof (pairing check failed)")
            return false
        }

        return true
    } catch (error) {
        console.error("ZK Verify: Verification error:", error)
        return false
    } finally {
        // REVIEW: HIGH FIX - Always terminate curve to prevent memory leaks
        // Curve objects may hold WASM instances and memory buffers
        if (curve && typeof curve.terminate === "function") {
            await curve.terminate()
        }
    }
}

function isWellConstructed(curve: any, proof: any): boolean {
    const G1 = curve.G1
    const G2 = curve.G2

    return G1.isValid(proof.pi_a) && G2.isValid(proof.pi_b) && G1.isValid(proof.pi_c)
}

function publicInputsAreValid(curve: any, publicInputs: any[]): boolean {
    for (let i = 0; i < publicInputs.length; i++) {
        if (!Scalar.lt(publicInputs[i], curve.r)) {
            return false
        }
    }
    return true
}
