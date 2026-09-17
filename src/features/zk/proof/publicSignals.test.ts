import { parseIdentityPublicSignals } from "./publicSignals"

/**
 * The circuit behind `verification_key_merkle.json` declares
 * `signal output nullifier` and `main {public [context, merkle_root]}`, so
 * its public signals are `[nullifier, context, merkle_root]`.
 */
const NULLIFIER = "111"
const CONTEXT = "222"
const MERKLE_ROOT = "333"

describe("parseIdentityPublicSignals", () => {
    it("reads the signals in the circuit's order", () => {
        const { signals } = parseIdentityPublicSignals([
            NULLIFIER,
            CONTEXT,
            MERKLE_ROOT,
        ])

        expect(signals).toEqual({
            nullifier: NULLIFIER,
            context: CONTEXT,
            merkleRoot: MERKLE_ROOT,
        })
    })

    it("does not mistake the context for the Merkle root", () => {
        // The old mapping read position 1 as the root. A prover chooses the
        // context freely, so setting it to the published tree root passed the
        // "is this root current" check while the real root — the statement
        // the membership proof is about — went unchecked, letting a proof
        // over a self-built tree through.
        const storedRoot = "999"
        const { signals } = parseIdentityPublicSignals([
            NULLIFIER,
            storedRoot,
            "attacker-tree-root",
        ])

        expect(signals?.merkleRoot).toBe("attacker-tree-root")
        expect(signals?.merkleRoot).not.toBe(storedRoot)
    })

    it("refuses a proof with no membership statement", () => {
        const { signals, reason } = parseIdentityPublicSignals([
            NULLIFIER,
            CONTEXT,
        ])

        expect(signals).toBeNull()
        expect(reason).toContain("expected 3")
    })

    it("refuses signals from another circuit", () => {
        const { signals } = parseIdentityPublicSignals([
            NULLIFIER,
            CONTEXT,
            MERKLE_ROOT,
            "extra",
        ])

        expect(signals).toBeNull()
    })

    it("refuses empty values and non-arrays", () => {
        expect(
            parseIdentityPublicSignals([NULLIFIER, "", MERKLE_ROOT]).signals,
        ).toBeNull()
        expect(parseIdentityPublicSignals(null).signals).toBeNull()
        expect(parseIdentityPublicSignals(undefined).signals).toBeNull()
    })
})
