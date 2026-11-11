import { describe, expect, it, mock } from "bun:test"
import { mockDatasource, mockLogger, mockXmLocalSdk } from "@/utilities/testSupport/coreMocks"

/**
 * The nullifier covers the context, and the prover picks the context. A
 * free context gives one identity any number of nullifiers and so any
 * number of attestation awards; under the fixed launch context it has one.
 */

mockDatasource({ findOne: async () => null })
mockLogger()
mockXmLocalSdk()

const { ProofVerifier } = await import("@/features/zk/proof/ProofVerifier")
// Stands in for a proof that verifies: the context rule is what is under test.
ProofVerifier.prototype.checkIdentityAttestation = async function (a: any) {
    return { valid: true, nullifier: a.publicSignals[0], context: a.publicSignals[1], merkleRoot: a.publicSignals[2] }
}

const { applyZkAttestationAdd } = await import("./zkRoutines")
const { default: handleIdentityRequest } = await import(
    "@/libs/network/routines/transactions/handleIdentityRequest"
)
const { ATTESTATION_CONTEXT, ATTESTATION_CONTEXT_SIGNAL } = await import("@/features/zk/proof/publicSignals")

/** The context signal the SDK prover (ProofGenerator.stringToBigInt) emits. */
const sdkContextSignal = (context: string) =>
    BigInt("0x" + Array.from(new TextEncoder().encode(context)).map(b => b.toString(16).padStart(2, "0")).join("")).toString()

const attestation = (context: string) => ({
    type: "identity",
    operation: "zk_attestationadd",
    account: "0x" + "ab".repeat(32),
    txhash: "cc".repeat(32),
    data: {
        nullifier_hash: "1" + "d".repeat(63),
        merkle_root: "2" + "e".repeat(63),
        proof: { pi_a: [], pi_b: [], pi_c: [], protocol: "groth16" },
        public_signals: ["123", sdkContextSignal(context), "456"],
    },
})

describe("ZK attestation context", () => {
    it("is the signal the SDK prover emits for the launch context string", () => {
        expect(ATTESTATION_CONTEXT_SIGNAL).toBe(sdkContextSignal(ATTESTATION_CONTEXT))
        expect(new TextEncoder().encode(ATTESTATION_CONTEXT).length).toBeLessThanOrEqual(31)
    })

    it("accepts an attestation under the launch context", async () => {
        const r = await applyZkAttestationAdd(attestation(ATTESTATION_CONTEXT), true)
        expect(r.success).toBe(true)
    })

    it("refuses an attestation under any other context, at admission and at apply", async () => {
        for (const simulate of [true, false]) {
            const r = await applyZkAttestationAdd(attestation("dao_vote_123"), simulate, { zkNullifiers: new Map() } as any)
            expect(r.success).toBe(false)
            expect(r.message).toContain(ATTESTATION_CONTEXT)
        }
    })

    it("is refused at the identity request too, so a client is not told an attestation apply drops passed", async () => {
        const request = (context: string) =>
            ({
                content: {
                    from_ed25519_address: "0x" + "ab".repeat(32),
                    data: ["identity", { method: "zk_attestationadd", payload: [attestation(context).data] }],
                },
            }) as any
        const wrong = await handleIdentityRequest(request("dao_vote_123"), "0x" + "ab".repeat(32))
        expect(wrong.success).toBe(false)
        expect(wrong.message).toContain(ATTESTATION_CONTEXT)
        const right = await handleIdentityRequest(request(ATTESTATION_CONTEXT), "0x" + "ab".repeat(32))
        expect(right.success).toBe(true)
    })
})
