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
    const [nullifier, context, merkleRoot] = publicSignals
    if (!nullifier || !context || !merkleRoot) {
        return {
            signals: null,
            reason:
                "Invalid public signals: empty nullifier, context or merkle root",
        }
    }
    return { signals: { nullifier, context, merkleRoot }, reason: null }
}
