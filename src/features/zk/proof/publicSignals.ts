/**
 * How to read the public signals of an identity attestation proof.
 *
 * The verifier loads `keys/verification_key_merkle.json`, i.e. the
 * `identity_with_merkle` circuit. That circuit declares one output and two
 * public inputs:
 *
 * ```circom
 * signal output nullifier;
 * component main {public [context, merkle_root]} = IdentityProofWithMerkle(20);
 * ```
 *
 * Circom emits outputs first, then public inputs in the order of the `public`
 * list, so the signals are `[nullifier, context, merkle_root]`.
 *
 * Reading position 1 as the Merkle root — as this code did — checks the
 * *context* against the current tree state and leaves the real root
 * unchecked. A prover picks the context freely: set it to the published tree
 * root and the check passes, while the membership proof itself can be against
 * a tree the prover built with their own commitment in it. The attestation
 * then proves nothing about belonging to the global tree.
 */
export interface IdentityPublicSignals {
    nullifier: string
    context: string
    merkleRoot: string
}

export const IDENTITY_PUBLIC_SIGNAL_COUNT = 3

/**
 * The only context a points-earning attestation may prove under. The
 * nullifier is Poseidon(provider_id, secret, context), so with a free
 * context one identity yields a fresh nullifier, and fresh points, per
 * context. The SDK prover takes the context as a string and uses its UTF-8
 * bytes as one big-endian number; this string is 29 bytes, inside the field.
 */
export const ATTESTATION_CONTEXT = "demos-identity-attestation-v1"

/** `ATTESTATION_CONTEXT` as the public signal the prover emits for it. */
export const ATTESTATION_CONTEXT_SIGNAL = BigInt(
    "0x" + Buffer.from(ATTESTATION_CONTEXT, "utf8").toString("hex"),
).toString(10)

/**
 * Read the signals by position, or explain why they cannot be trusted.
 *
 * Fails closed on any other length: a proof carrying fewer signals comes from
 * a circuit without the membership statement, and one carrying more is not
 * the circuit this verification key belongs to.
 */
export interface ParsedIdentityPublicSignals {
    /** Null when the signals cannot be read; `reason` then says why. */
    signals: IdentityPublicSignals | null
    reason: string | null
}

export function parseIdentityPublicSignals(
    publicSignals: string[] | undefined | null,
): ParsedIdentityPublicSignals {
    if (!Array.isArray(publicSignals)) {
        return {
            signals: null,
            reason: "Invalid public signals: expected an array",
        }
    }
    if (publicSignals.length !== IDENTITY_PUBLIC_SIGNAL_COUNT) {
        return {
            signals: null,
            reason:
                `Invalid public signals: expected ${IDENTITY_PUBLIC_SIGNAL_COUNT} ` +
                `([nullifier, context, merkle_root]), got ${publicSignals.length}`,
        }
    }
    const [rawNullifier, rawContext, rawMerkleRoot] = publicSignals
    if (!rawNullifier || !rawContext || !rawMerkleRoot) {
        return {
            signals: null,
            reason:
                "Invalid public signals: empty nullifier, context or merkle root",
        }
    }

    // Canonicalise before anything compares or stores these as text — see
    // canonicalFieldElement.
    const nullifier = canonicalFieldElement(rawNullifier)
    const context = canonicalFieldElement(rawContext)
    const merkleRoot = canonicalFieldElement(rawMerkleRoot)
    if (!nullifier || !context || !merkleRoot) {
        return {
            signals: null,
            reason: "Invalid public signals: not field elements",
        }
    }

    return { signals: { nullifier, context, merkleRoot }, reason: null }
}

/**
 * BN254's scalar field order — the modulus snarkjs reduces public signals by
 * before checking a Groth16 proof.
 */
export const BN254_FIELD_ORDER = BigInt(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617",
)

/**
 * The canonical decimal form of a field element.
 *
 * Signals arrive as strings and are only meaningful as field elements: the
 * proof check parses them, so "42", "042" and "0x2a" are the same element and
 * all verify. Anything that compares or stores them as text — the used
 * nullifier table, the Merkle root check — sees three different values, which
 * turns a spent nullifier into a fresh one and lets the same identity attest
 * again and again.
 *
 * Reducing modulo the field order closes the same gap from the other side: a
 * value and that value plus the order are one element to the verifier.
 *
 * Returns null when the text is not a number at all, so callers fail closed
 * rather than storing something that compares equal to nothing.
 */
export function canonicalFieldElement(value: string): string | null {
    const text = value.trim()
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) {
        return null
    }
    try {
        const asBigInt = BigInt(text) % BN254_FIELD_ORDER
        return asBigInt.toString(10)
    } catch {
        return null
    }
}

/**
 * Why an attestation does not prove under the launch context, or null.
 * Unreadable signals pass here: the proof check refuses them with its own
 * reason. A pure function of the signed payload, so admission and every
 * node's apply reach the same verdict.
 */
export function attestationContextError(
    publicSignals: string[] | undefined | null,
): string | null {
    const signals = parseIdentityPublicSignals(publicSignals).signals
    if (signals && signals.context !== ATTESTATION_CONTEXT_SIGNAL) {
        return `ZK attestation must prove under the context "${ATTESTATION_CONTEXT}"`
    }
    return null
}
