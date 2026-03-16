/**
 * Bun-Compatible PLONK Verify
 *
 * Direct port of snarkjs plonk_verify.js with singleThread curve initialization
 * to avoid Bun worker thread crashes.
 * 
 * Based on: https://github.com/iden3/snarkjs/blob/master/src/plonk_verify.js
 * Paper: https://eprint.iacr.org/2019/953.pdf
 */

/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/ban-ts-comment */

import { getCurveFromName, utils, Scalar } from "ffjavascript"
// @ts-ignore
import jsSha3 from "js-sha3"
const { keccak256 } = jsSha3

const { unstringifyBigInts } = utils
import { getErrorMessage } from "@/utilities/errorMessage"

// ============================================================================
// Keccak256Transcript - Fiat-Shamir transcript for PLONK challenges
// Ported from snarkjs/src/Keccak256Transcript.js
// ============================================================================

const POLYNOMIAL = 0
const SCALAR = 1

class Keccak256Transcript {
    private readonly G1: any
    private readonly Fr: any
    private data: Array<{ type: number; data: any }>

    constructor(curve: any) {
        this.G1 = curve.G1
        this.Fr = curve.Fr
        this.data = []
    }

    reset() {
        this.data = []
    }

    addPolCommitment(polynomialCommitment: any) {
        this.data.push({ type: POLYNOMIAL, data: polynomialCommitment })
    }

    addScalar(scalar: any) {
        this.data.push({ type: SCALAR, data: scalar })
    }

    getChallenge() {
        if (this.data.length === 0) {
            throw new Error("Keccak256Transcript: No data to generate a transcript")
        }

        let nPolynomials = 0
        let nScalars = 0

        this.data.forEach((element) => (POLYNOMIAL === element.type ? nPolynomials++ : nScalars++))

        const buffer = new Uint8Array(nScalars * this.Fr.n8 + nPolynomials * this.G1.F.n8 * 2)
        let offset = 0

        for (const item of this.data) {
            if (POLYNOMIAL === item.type) {
                this.G1.toRprUncompressed(buffer, offset, item.data)
                offset += this.G1.F.n8 * 2
            } else {
                this.Fr.toRprBE(buffer, offset, item.data)
                offset += this.Fr.n8
            }
        }

        const value = Scalar.fromRprBE(new Uint8Array(keccak256.arrayBuffer(buffer)))
        return this.Fr.e(value)
    }
}

function logChallenges(logger: any, Fr: any, challenges: any) {
    logger.debug("beta: " + Fr.toString(challenges.beta, 16))
    logger.debug("gamma: " + Fr.toString(challenges.gamma, 16))
    logger.debug("alpha: " + Fr.toString(challenges.alpha, 16))
    logger.debug("xi: " + Fr.toString(challenges.xi, 16))
    for (let i = 1; i < 6; i++) {
        logger.debug("v: " + Fr.toString(challenges.v[i], 16))
    }
    logger.debug("u: " + Fr.toString(challenges.u, 16))
}

function logLagrange(logger: any, Fr: any, L: any[]) {
    for (let i = 1; i < L.length; i++) {
        logger.debug(`L${i}(xi)=` + Fr.toString(L[i], 16))
    }
}

async function initializeCurve(vk_verifier: any) {
    // CRITICAL: Use singleThread to avoid Bun worker crashes
    return await getCurveFromName(vk_verifier.curve, true)
}

function validateInputs(vk_verifier: any, publicSignals: any[], proof: any, curve: any, logger?: any): boolean {
    if (!isWellConstructed(curve, proof)) {
        if (logger) logger.error("Proof is not well constructed")
        return false
    }

    if (publicSignals.length !== vk_verifier.nPublic) {
        if (logger) logger.error("Invalid number of public inputs")
        return false
    }
    return true
}

function performCalculations(curve: any, proof: any, publicSignals: any[], vk_verifier: any, logger?: any) {
    const Fr = curve.Fr
    const G1 = curve.G1

    const challenges = calculateChallenges(curve, proof, publicSignals, vk_verifier)
    if (logger) logChallenges(logger, Fr, challenges)

    const L = calculateLagrangeEvaluations(curve, challenges, vk_verifier)
    if (logger) logLagrange(logger, Fr, L)

    const pi = calculatePI(curve, publicSignals, L)
    if (logger) logger.debug("PI(xi): " + Fr.toString(pi, 16))

    const r0 = calculateR0(curve, proof, challenges, pi, L[1])
    const D = calculateD(curve, proof, challenges, vk_verifier, L[1])
    const F = calculateF(curve, proof, challenges, vk_verifier, D)
    const E = calculateE(curve, proof, challenges, r0)

    if (logger) {
        logger.debug("r0: " + Fr.toString(r0, 16))
        logger.debug("D: " + G1.toString(G1.toAffine(D), 16))
        logger.debug("F: " + G1.toString(G1.toAffine(F), 16))
        logger.debug("E: " + G1.toString(G1.toAffine(E), 16))
    }

    return { challenges, E, F }
}

/**
 * Verify a PLONK proof (Bun-compatible, single-threaded)
 * 
 * This is a direct port of snarkjs.plonk.verify with the only change being
 * the curve initialization uses singleThread: true
 */
export async function plonkVerifyBun(
    _vk_verifier: any,
    _publicSignals: any[],
    _proof: any,
    logger?: any
): Promise<boolean> {
    let curve: any = null
    
    try {
        const vk_verifier_raw = unstringifyBigInts(_vk_verifier)
        const proofRaw = unstringifyBigInts(_proof)
        const publicSignals = unstringifyBigInts(_publicSignals)

        curve = await initializeCurve(vk_verifier_raw)
        if (logger) logger.info("PLONK VERIFIER STARTED (Bun-compatible)")

        const proof = fromObjectProof(curve, proofRaw)
        const vk_verifier = fromObjectVk(curve, vk_verifier_raw)

        if (!validateInputs(vk_verifier, publicSignals, proof, curve, logger)) {
            return false
        }

        const { challenges, E, F } = performCalculations(curve, proof, publicSignals, vk_verifier, logger)

        const res = await isValidPairing(curve, proof, challenges, vk_verifier, E, F)

        if (logger) {
            if (res) {
                logger.info("OK!")
            } else {
                logger.warn("Invalid Proof")
            }
        }

        return res

    } catch (error) {
        const message = getErrorMessage(error)
        console.error("PLONK Verify error:", message)
        return false
    } finally {
        // Terminate curve to prevent memory leaks
        if (curve && typeof curve.terminate === "function") {
            await curve.terminate()
        }
    }
}

function fromObjectProof(curve: any, proof: any) {
    const G1 = curve.G1
    const Fr = curve.Fr
    return {
        A: G1.fromObject(proof.A),
        B: G1.fromObject(proof.B),
        C: G1.fromObject(proof.C),
        Z: G1.fromObject(proof.Z),
        T1: G1.fromObject(proof.T1),
        T2: G1.fromObject(proof.T2),
        T3: G1.fromObject(proof.T3),
        eval_a: Fr.fromObject(proof.eval_a),
        eval_b: Fr.fromObject(proof.eval_b),
        eval_c: Fr.fromObject(proof.eval_c),
        eval_zw: Fr.fromObject(proof.eval_zw),
        eval_s1: Fr.fromObject(proof.eval_s1),
        eval_s2: Fr.fromObject(proof.eval_s2),
        Wxi: G1.fromObject(proof.Wxi),
        Wxiw: G1.fromObject(proof.Wxiw),
    }
}

function fromObjectVk(curve: any, vk: any) {
    const G1 = curve.G1
    const G2 = curve.G2
    const Fr = curve.Fr
    return {
        ...vk,
        Qm: G1.fromObject(vk.Qm),
        Ql: G1.fromObject(vk.Ql),
        Qr: G1.fromObject(vk.Qr),
        Qo: G1.fromObject(vk.Qo),
        Qc: G1.fromObject(vk.Qc),
        S1: G1.fromObject(vk.S1),
        S2: G1.fromObject(vk.S2),
        S3: G1.fromObject(vk.S3),
        k1: Fr.fromObject(vk.k1),
        k2: Fr.fromObject(vk.k2),
        X_2: G2.fromObject(vk.X_2),
    }
}

function isWellConstructed(curve: any, proof: any): boolean {
    const G1 = curve.G1
    return (
        G1.isValid(proof.A) &&
        G1.isValid(proof.B) &&
        G1.isValid(proof.C) &&
        G1.isValid(proof.Z) &&
        G1.isValid(proof.T1) &&
        G1.isValid(proof.T2) &&
        G1.isValid(proof.T3) &&
        G1.isValid(proof.Wxi) &&
        G1.isValid(proof.Wxiw)
    )
}

function calculateChallenges(curve: any, proof: any, publicSignals: any[], vk: any) {
    const Fr = curve.Fr
    const res: any = {}
    const transcript = new Keccak256Transcript(curve)

    // Challenge round 2: beta and gamma
    transcript.addPolCommitment(vk.Qm)
    transcript.addPolCommitment(vk.Ql)
    transcript.addPolCommitment(vk.Qr)
    transcript.addPolCommitment(vk.Qo)
    transcript.addPolCommitment(vk.Qc)
    transcript.addPolCommitment(vk.S1)
    transcript.addPolCommitment(vk.S2)
    transcript.addPolCommitment(vk.S3)

    for (const signal of publicSignals) {
        transcript.addScalar(Fr.e(signal))
    }

    transcript.addPolCommitment(proof.A)
    transcript.addPolCommitment(proof.B)
    transcript.addPolCommitment(proof.C)

    res.beta = transcript.getChallenge()

    transcript.reset()
    transcript.addScalar(res.beta)
    res.gamma = transcript.getChallenge()

    // Challenge round 3: alpha
    transcript.reset()
    transcript.addScalar(res.beta)
    transcript.addScalar(res.gamma)
    transcript.addPolCommitment(proof.Z)
    res.alpha = transcript.getChallenge()

    // Challenge round 4: xi
    transcript.reset()
    transcript.addScalar(res.alpha)
    transcript.addPolCommitment(proof.T1)
    transcript.addPolCommitment(proof.T2)
    transcript.addPolCommitment(proof.T3)
    res.xi = transcript.getChallenge()

    // Challenge round 5: v
    transcript.reset()
    transcript.addScalar(res.xi)
    transcript.addScalar(proof.eval_a)
    transcript.addScalar(proof.eval_b)
    transcript.addScalar(proof.eval_c)
    transcript.addScalar(proof.eval_s1)
    transcript.addScalar(proof.eval_s2)
    transcript.addScalar(proof.eval_zw)
    res.v = []
    res.v[1] = transcript.getChallenge()

    for (let i = 2; i < 6; i++) {
        res.v[i] = Fr.mul(res.v[i - 1], res.v[1])
    }

    // Challenge: u
    transcript.reset()
    transcript.addPolCommitment(proof.Wxi)
    transcript.addPolCommitment(proof.Wxiw)
    res.u = transcript.getChallenge()

    return res
}

function calculateLagrangeEvaluations(curve: any, challenges: any, vk: any) {
    const Fr = curve.Fr

    let xin = challenges.xi
    let domainSize = 1
    for (let i = 0; i < vk.power; i++) {
        xin = Fr.square(xin)
        domainSize *= 2
    }
    challenges.xin = xin
    challenges.zh = Fr.sub(xin, Fr.one)

    const L: any[] = []
    const n = Fr.e(domainSize)
    let w = Fr.one
    
    for (let i = 1; i <= Math.max(1, vk.nPublic); i++) {
        L[i] = Fr.div(Fr.mul(w, challenges.zh), Fr.mul(n, Fr.sub(challenges.xi, w)))
        w = Fr.mul(w, Fr.w[vk.power])
    }

    return L
}

function calculatePI(curve: any, publicSignals: any[], L: any[]) {
    const Fr = curve.Fr

    let pi = Fr.zero
    for (const [i, signal] of publicSignals.entries()) {
        const w = Fr.e(signal)
        pi = Fr.sub(pi, Fr.mul(w, L[i + 1]))
    }
    return pi
}

function calculateR0(curve: any, proof: any, challenges: any, pi: any, l1: any) {
    const Fr = curve.Fr

    const e1 = pi
    const e2 = Fr.mul(l1, Fr.square(challenges.alpha))

    let e3a = Fr.add(proof.eval_a, Fr.mul(challenges.beta, proof.eval_s1))
    e3a = Fr.add(e3a, challenges.gamma)

    let e3b = Fr.add(proof.eval_b, Fr.mul(challenges.beta, proof.eval_s2))
    e3b = Fr.add(e3b, challenges.gamma)

    const e3c = Fr.add(proof.eval_c, challenges.gamma)

    let e3 = Fr.mul(Fr.mul(e3a, e3b), e3c)
    e3 = Fr.mul(e3, proof.eval_zw)
    e3 = Fr.mul(e3, challenges.alpha)

    return Fr.sub(Fr.sub(e1, e2), e3)
}

function calculateD(curve: any, proof: any, challenges: any, vk: any, l1: any) {
    const G1 = curve.G1
    const Fr = curve.Fr

    let d1 = G1.timesFr(vk.Qm, Fr.mul(proof.eval_a, proof.eval_b))
    d1 = G1.add(d1, G1.timesFr(vk.Ql, proof.eval_a))
    d1 = G1.add(d1, G1.timesFr(vk.Qr, proof.eval_b))
    d1 = G1.add(d1, G1.timesFr(vk.Qo, proof.eval_c))
    d1 = G1.add(d1, vk.Qc)

    const betaxi = Fr.mul(challenges.beta, challenges.xi)

    const d2a1 = Fr.add(Fr.add(proof.eval_a, betaxi), challenges.gamma)
    const d2a2 = Fr.add(Fr.add(proof.eval_b, Fr.mul(betaxi, vk.k1)), challenges.gamma)
    const d2a3 = Fr.add(Fr.add(proof.eval_c, Fr.mul(betaxi, vk.k2)), challenges.gamma)

    const d2a = Fr.mul(Fr.mul(Fr.mul(d2a1, d2a2), d2a3), challenges.alpha)
    const d2b = Fr.mul(l1, Fr.square(challenges.alpha))

    const d2 = G1.timesFr(proof.Z, Fr.add(Fr.add(d2a, d2b), challenges.u))

    const d3a = Fr.add(Fr.add(proof.eval_a, Fr.mul(challenges.beta, proof.eval_s1)), challenges.gamma)
    const d3b = Fr.add(Fr.add(proof.eval_b, Fr.mul(challenges.beta, proof.eval_s2)), challenges.gamma)
    const d3c = Fr.mul(Fr.mul(challenges.alpha, challenges.beta), proof.eval_zw)

    const d3 = G1.timesFr(vk.S3, Fr.mul(Fr.mul(d3a, d3b), d3c))

    const d4low = proof.T1
    const d4mid = G1.timesFr(proof.T2, challenges.xin)
    const d4high = G1.timesFr(proof.T3, Fr.square(challenges.xin))
    let d4 = G1.add(d4low, G1.add(d4mid, d4high))
    d4 = G1.timesFr(d4, challenges.zh)

    return G1.sub(G1.sub(G1.add(d1, d2), d3), d4)
}

function calculateF(curve: any, proof: any, challenges: any, vk: any, D: any) {
    const G1 = curve.G1

    let res = G1.add(D, G1.timesFr(proof.A, challenges.v[1]))
    res = G1.add(res, G1.timesFr(proof.B, challenges.v[2]))
    res = G1.add(res, G1.timesFr(proof.C, challenges.v[3]))
    res = G1.add(res, G1.timesFr(vk.S1, challenges.v[4]))
    res = G1.add(res, G1.timesFr(vk.S2, challenges.v[5]))

    return res
}

function calculateE(curve: any, proof: any, challenges: any, r0: any) {
    const G1 = curve.G1
    const Fr = curve.Fr

    let e = Fr.add(Fr.neg(r0), Fr.mul(challenges.v[1], proof.eval_a))
    e = Fr.add(e, Fr.mul(challenges.v[2], proof.eval_b))
    e = Fr.add(e, Fr.mul(challenges.v[3], proof.eval_c))
    e = Fr.add(e, Fr.mul(challenges.v[4], proof.eval_s1))
    e = Fr.add(e, Fr.mul(challenges.v[5], proof.eval_s2))
    e = Fr.add(e, Fr.mul(challenges.u, proof.eval_zw))

    return G1.timesFr(G1.one, e)
}

async function isValidPairing(curve: any, proof: any, challenges: any, vk: any, E: any, F: any): Promise<boolean> {
    const G1 = curve.G1
    const Fr = curve.Fr

    let A1 = proof.Wxi
    A1 = G1.add(A1, G1.timesFr(proof.Wxiw, challenges.u))

    let B1 = G1.timesFr(proof.Wxi, challenges.xi)
    const s = Fr.mul(Fr.mul(challenges.u, challenges.xi), Fr.w[vk.power])
    B1 = G1.add(B1, G1.timesFr(proof.Wxiw, s))
    B1 = G1.add(B1, F)
    B1 = G1.sub(B1, E)

    return await curve.pairingEq(G1.neg(A1), vk.X_2, B1, curve.G2.one)
}
