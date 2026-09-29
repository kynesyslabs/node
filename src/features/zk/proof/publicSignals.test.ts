import {
    BN254_FIELD_ORDER,
    canonicalFieldElement,
    parseIdentityPublicSignals,
} from "./publicSignals"

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
        const attackerTreeRoot = "12345"
        const { signals } = parseIdentityPublicSignals([
            NULLIFIER,
            storedRoot,
            attackerTreeRoot,
        ])

        expect(signals?.merkleRoot).toBe(attackerTreeRoot)
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

describe("canonicalFieldElement", () => {
    it("treats leading zeroes as the same element", () => {
        expect(canonicalFieldElement("042")).toBe(canonicalFieldElement("42"))
    })

    it("treats hex and decimal as the same element", () => {
        expect(canonicalFieldElement("0x2a")).toBe("42")
    })

    it("reduces a value shifted by the field order", () => {
        const shifted = (BN254_FIELD_ORDER + 42n).toString()

        expect(canonicalFieldElement(shifted)).toBe("42")
    })

    it("rejects anything that is not a number", () => {
        expect(canonicalFieldElement("nullifier")).toBeNull()
        expect(canonicalFieldElement("")).toBeNull()
        expect(canonicalFieldElement("12ab")).toBeNull()
    })
})

describe("a spent nullifier cannot be re-spelled", () => {
    it("normalises every accepted spelling to one value", () => {
        // All three verify as the same proof statement, so the used-nullifier
        // table has to see one value, or the identity attests again.
        const spellings = ["42", "042", "0x2a"]

        const parsed = spellings.map(
            spelling =>
                parseIdentityPublicSignals([spelling, "7", "9"]).signals
                    ?.nullifier,
        )

        expect(new Set(parsed).size).toBe(1)
        expect(parsed[0]).toBe("42")
    })
})
