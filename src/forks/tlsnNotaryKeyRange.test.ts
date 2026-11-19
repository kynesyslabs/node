/**
 * Height-scoped notary keys (`validFrom` / `validUntil` on a `tlsnVerified`
 * key) and the way back after the kill switch (`reenableAt` on
 * `tlsnDisabled`), kynesyslabs/node#1250.
 *
 * Heights: fork activation is judged at the tip the block is applied on, as
 * for every fork; a key's range and `reenableAt` at the height of the block
 * itself, tip + 1. The replay cases judge a presentation the way block apply
 * does, through `judgePresentation` with a stand-in verifier that reports the
 * signing key, so the verdict for a block depends on the fork file only.
 */

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { tlsnDisabledAt } from "@/forks/tlsnDisabledGate"
import { isTrustedNotaryKey, tlsnVerifiedParams } from "@/forks/tlsnVerifiedGate"
import { notaryKeyProblems } from "@/forks/tlsnVerifiedPayload"
import { VERIFIER_WASM_SHA256, notaryKeyHex, tlsnVerifiedPayload } from "@/libs/blockchain/testSupport/tlsnVerifiedFixtures"
import { forkScheduleDigest, type ForkConfigLike } from "@/libs/peer/routines/forkScheduleAgreement"
import { judgePresentation, setPresentationVerifierForTests } from "@/libs/tlsnotary/presentationGate"
import { getSharedState } from "@/utilities/sharedState"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"
import template from "../../docs/mainnet/genesis.template.json"

const K1 = notaryKeyHex(0x11)
const K2 = notaryKeyHex(0x22)
const K3 = notaryKeyHex(0x33)

const key = (id: string, hex: string, range: Record<string, unknown> = {}) => ({ id, alg: "k256", hex, ...range })
const verified = (notaryKeys: unknown[], activationHeight = 0) => ({
    activationHeight,
    ...tlsnVerifiedPayload({ notaryKeys }),
})
const load = (forks: Record<string, unknown>) => loadForkConfigFromGenesis({ forks })
const digest = () => forkScheduleDigest(getSharedState.forkConfig as unknown as ForkConfigLike, 7)

/** A block's time; the stand-in attests at it, so freshness always passes. */
const BLOCK_TIME = 1_800_000_000

/**
 * What the node does with a TLSNotary claim signed by `hex` in block
 * `block`: the kill switch refuses it before any edit, then the presentation
 * is judged on the block's tip.
 */
function verdictFor(block: number, hex: string): "disabled" | "verified" | "refused" {
    const tip = block - 1
    if (tlsnDisabledAt(tip)) return "disabled"
    signer = hex
    return judgePresentation("00", { height: tip, blockTimeSec: BLOCK_TIME }).ok ? "verified" : "refused"
}

let signer = K1
let saved: { forkConfig: ForkConfigByName; chainId: number | null }

beforeEach(() => {
    saved = { forkConfig: getSharedState.forkConfig, chainId: getSharedState.chainId }
    getSharedState.forkConfig = cloneDefaultForkConfig()
    setPresentationVerifierForTests({
        wasmSha256: VERIFIER_WASM_SHA256,
        verify: () =>
            ({
                ok: true,
                raw: "",
                out: {
                    ok: true,
                    attestationId: "ab".repeat(16),
                    attestationVersionIsCurrent: true,
                    signatureAlg: "secp256k1",
                    verifyingKey: { alg: "k256", hex: signer },
                    serverName: "api.example.com",
                    time: BLOCK_TIME,
                    tlsVersion: "1.2",
                    transcriptLength: { sent: 0, received: 0 },
                    sent: null,
                    sentAuthed: null,
                    recv: null,
                    recvAuthed: null,
                    extensions: 0,
                },
            }) as never,
    })
})

afterEach(() => {
    getSharedState.forkConfig = saved.forkConfig
    getSharedState.chainId = saved.chainId
    setPresentationVerifierForTests(null)
})

describe("notary keys without a range (every existing fork file)", () => {
    it("load as {id, alg, hex} only, so the schedule digest is the one the base computed", () => {
        // The devnet genesis is the one checked-in genesis that loads (the
        // mainnet template holds FILL placeholders); neither carries a range.
        loadForkConfigFromGenesis(devnetGenesis)
        const config = getSharedState.forkConfig
        expect(config.tlsnVerified.notaryKeys).toHaveLength(2)
        for (const k of config.tlsnVerified.notaryKeys ?? []) {
            expect(Object.keys(k)).toEqual(["id", "alg", "hex"])
        }
        expect(Object.hasOwn(config.tlsnDisabled, "reenableAt")).toBe(false)
        const templateKeys = (template.forks as Record<string, { notaryKeys?: object[] }>).tlsnVerified.notaryKeys ?? []
        for (const k of templateKeys) expect(Object.keys(k)).toEqual(["id", "alg", "hex"])

        getSharedState.forkConfig = cloneDefaultForkConfig()
        load({ tlsnVerified: verified([key("a", K1)], 100) })
        const before = digest()
        const plain = (getSharedState.forkConfig.tlsnVerified.notaryKeys ?? []).map(k => ({ id: k.id, alg: k.alg, hex: k.hex }))
        expect(plain).toHaveLength(1)
        getSharedState.forkConfig.tlsnVerified = { ...getSharedState.forkConfig.tlsnVerified, notaryKeys: plain }
        expect(digest()).toBe(before)
    })

    it("are trusted at every height from activation on, as before", () => {
        load({ tlsnVerified: verified([key("a", K1)], 100) })
        expect(isTrustedNotaryKey(99, "k256", K1)).toBe(false)
        for (const tip of [100, 101, 5_000, 10_000_000]) expect(isTrustedNotaryKey(tip, "k256", K1)).toBe(true)
        expect(verdictFor(101, K1)).toBe("verified")
        expect(verdictFor(10_000_000, K1)).toBe("verified")
    })
})

describe("validFrom / validUntil at load", () => {
    it("are kept on the key, frozen, and put in the schedule digest", () => {
        load({ tlsnVerified: verified([key("a", K1)], 100) })
        const open = digest()
        load({ tlsnVerified: verified([key("a", K1, { validFrom: 100, validUntil: 500 })], 100) })
        const first = tlsnVerifiedParams(100)?.notaryKeys[0]
        expect(first).toEqual({ id: "a", alg: "k256", hex: K1, validFrom: 100, validUntil: 500 })
        expect(() => {
            const mutable = first as { validUntil?: number }
            mutable.validUntil = 900
        }).toThrow()
        const closed = digest()
        load({ tlsnVerified: verified([key("a", K1, { validFrom: 100, validUntil: 600 })], 100) })
        expect(new Set([open, closed, digest()]).size).toBe(3)
    })

    it("accept either end alone, an end at the activation height, and an empty range", () => {
        load({ tlsnVerified: verified([key("a", K1, { validFrom: 100 }), key("b", K2, { validUntil: 100 })], 100) })
        load({ tlsnVerified: verified([key("a", K1, { validFrom: 300, validUntil: 300 })], 100) })
        // An unscheduled entry has no activation height to compare with.
        load({ tlsnVerified: verified([key("a", K1, { validFrom: 0 })], null as unknown as number) })
    })

    const refused: Array<[string, Record<string, unknown>, RegExp]> = [
        ["a validFrom below the activation height", { validFrom: 99 }, /validFrom must be an integer block height at or above activationHeight 100, got 99/],
        ["a validUntil below the activation height", { validUntil: 50 }, /validUntil must be an integer block height at or above activationHeight 100/],
        ["a fractional validFrom", { validFrom: 150.5 }, /validFrom must be an integer/],
        ["a validUntil as a string", { validUntil: "500" }, /validUntil must be an integer/],
        ["a null validFrom", { validFrom: null }, /validFrom must be an integer/],
        ["a validFrom above validUntil", { validFrom: 501, validUntil: 500 }, /validFrom 501 is above validUntil 500/],
        ["a misspelt end", { validTo: 500 }, /unknown field "validTo"/],
    ]
    for (const [what, range, why] of refused) {
        it(`refuses ${what}`, () => {
            const entry = { tlsnVerified: verified([key("a", K1, range)], 100) }
            expect(() => load(entry)).toThrow(ForkConfigValidationError)
            expect(() => load(entry)).toThrow(why)
        })
    }

    it("leaves the launch tool's id/alg/hex check as it was", () => {
        expect(notaryKeyProblems({ id: "a", alg: "k256", hex: K1 }, "k")).toEqual([])
    })
})

describe("a key's range, judged at the block it lands in", () => {
    beforeEach(() => {
        load({ tlsnVerified: verified([key("old", K1, { validUntil: 200 }), key("new", K2, { validFrom: 150 })], 0) })
    })

    it("refuses a key before validFrom and from validUntil on, and accepts it in between", () => {
        expect(verdictFor(149, K2)).toBe("refused")
        expect(verdictFor(150, K2)).toBe("verified")
        expect(verdictFor(1_000_000, K2)).toBe("verified")
        expect(verdictFor(1, K1)).toBe("verified")
        expect(verdictFor(199, K1)).toBe("verified")
        expect(verdictFor(200, K1)).toBe("refused")
        expect(verdictFor(201, K1)).toBe("refused")
    })

    it("tells admission the verdict of the next block: tip 149 admits for block 150", () => {
        // Admission passes the node's tip; the key is judged at tip + 1.
        expect(isTrustedNotaryKey(148, "k256", K2)).toBe(false)
        expect(isTrustedNotaryKey(149, "k256", K2)).toBe(true)
        expect(isTrustedNotaryKey(198, "k256", K1)).toBe(true)
        expect(isTrustedNotaryKey(199, "k256", K1)).toBe(false)
    })

    it("refuses a key no entry lists", () => {
        expect(verdictFor(160, K3)).toBe("refused")
    })
})

describe("replay after a key is closed", () => {
    it("verifies a block applied before validUntil the same way on resync, where removing the key would not", () => {
        // v1: the key as launched, no range. Block 150 is applied under it.
        load({ tlsnVerified: verified([key("old", K1), key("standby", K2)], 0) })
        const applied = verdictFor(150, K1)
        expect(applied).toBe("verified")

        // v2 closes the compromised key at 200 and lists its successor.
        load({
            tlsnVerified: verified(
                [key("old", K1, { validUntil: 200 }), key("standby", K2), key("next", K3, { validFrom: 200 })],
                0,
            ),
        })
        expect(verdictFor(150, K1)).toBe(applied)
        expect(verdictFor(199, K1)).toBe("verified")
        expect(verdictFor(200, K1)).toBe("refused")
        expect(verdictFor(199, K3)).toBe("refused")
        expect(verdictFor(200, K3)).toBe("verified")

        // What the issue describes: dropping the key changes block 150's verdict.
        load({ tlsnVerified: verified([key("standby", K2), key("next", K3)], 0) })
        expect(verdictFor(150, K1)).toBe("refused")
    })
})

describe("tlsnDisabled.reenableAt", () => {
    it("loads, and is checked like the other fork heights", () => {
        load({ tlsnDisabled: { activationHeight: 300, reenableAt: 400 } })
        expect(getSharedState.forkConfig.tlsnDisabled).toMatchObject({ activationHeight: 300, reenableAt: 400 })
        load({ tlsnDisabled: { activationHeight: 300, reenableAt: null } })
        expect(Object.hasOwn(getSharedState.forkConfig.tlsnDisabled, "reenableAt")).toBe(false)
        for (const bad of [300, 299, 400.5, "400", true]) {
            const entry = { tlsnDisabled: { activationHeight: 300, reenableAt: bad } }
            expect(() => load(entry)).toThrow(ForkConfigValidationError)
            expect(() => load(entry)).toThrow(/reenableAt must be an integer block height of at least a scheduled activationHeight/)
        }
        expect(() => load({ tlsnDisabled: { activationHeight: null, reenableAt: 400 } })).toThrow(/scheduled activationHeight/)
    })

    it("refuses activationHeight + 1, a window with no block, and accepts + 2, which refuses block H + 1 only", () => {
        expect(() => load({ tlsnDisabled: { activationHeight: 300, reenableAt: 301 } })).toThrow(
            /reenableAt must be an integer block height of at least a scheduled activationHeight \(300\) \+ 2, as a lower one would refuse no block, got: 301/,
        )
        load({ tlsnDisabled: { activationHeight: 300, reenableAt: 302 } })
        expect(getSharedState.forkConfig.tlsnDisabled).toMatchObject({ activationHeight: 300, reenableAt: 302 })
        expect(tlsnDisabledAt(299)).toBe(false) // block 300
        expect(tlsnDisabledAt(300)).toBe(true) // block 301
        expect(tlsnDisabledAt(301)).toBe(false) // block 302
    })

    it("is in the schedule digest, and its absence leaves the digest as it was", () => {
        load({ tlsnDisabled: { activationHeight: 300 } })
        const switchOn = digest()
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.forkConfig.tlsnDisabled = { activationHeight: 300 }
        expect(digest()).toBe(switchOn)
        load({ tlsnDisabled: { activationHeight: 300, reenableAt: 400 } })
        expect(digest()).not.toBe(switchOn)
    })

    it("keeps the switch on for good without it, as before", () => {
        load({ tlsnDisabled: { activationHeight: 300 } })
        expect(tlsnDisabledAt(299)).toBe(false)
        expect(tlsnDisabledAt(300)).toBe(true)
        expect(tlsnDisabledAt(10_000_000)).toBe(true)
    })

    it("lifts the switch from the block at reenableAt", () => {
        load({ tlsnDisabled: { activationHeight: 300, reenableAt: 400 } })
        expect(tlsnDisabledAt(299)).toBe(false)
        expect(tlsnDisabledAt(300)).toBe(true)
        expect(tlsnDisabledAt(398)).toBe(true) // block 399
        expect(tlsnDisabledAt(399)).toBe(false) // block 400
        expect(tlsnDisabledAt(10_000_000)).toBe(false)
    })
})

describe("compromise, kill switch, new key, re-enable: one fork file, replayed", () => {
    // K1 is compromised: TLSNotary is switched off from block 301 (tip 300),
    // K1 is closed at 301, K3 is listed from 400 and claims come back at 400.
    const forks = {
        tlsnVerified: verified(
            [key("old", K1, { validUntil: 301 }), key("standby", K2, { validUntil: 301 }), key("next", K3, { validFrom: 400 })],
            0,
        ),
        tlsnDisabled: { activationHeight: 300, reenableAt: 400 },
    }

    it("verifies below the disable height, refuses in the window and verifies again at reenableAt", () => {
        load(forks)
        expect(verdictFor(250, K1)).toBe("verified")
        expect(verdictFor(300, K1)).toBe("verified")
        expect(verdictFor(301, K1)).toBe("disabled")
        expect(verdictFor(301, K3)).toBe("disabled")
        expect(verdictFor(399, K3)).toBe("disabled")
        expect(verdictFor(400, K3)).toBe("verified")
        expect(verdictFor(400, K1)).toBe("refused")
        expect(verdictFor(400, K2)).toBe("refused")
        expect(verdictFor(5_000, K3)).toBe("verified")
    })

    it("gives every block the same verdict on a second load (resync)", () => {
        load(forks)
        const blocks = [1, 250, 300, 301, 350, 399, 400, 401, 5_000]
        const first = blocks.flatMap(b => [K1, K2, K3].map(k => verdictFor(b, k)))
        getSharedState.forkConfig = cloneDefaultForkConfig()
        load(JSON.parse(JSON.stringify(forks)))
        expect(blocks.flatMap(b => [K1, K2, K3].map(k => verdictFor(b, k)))).toEqual(first)
    })
})

describe("closing a key in the re-enable release (runbook section 7 step 4)", () => {
    // The switch was not paired with a close: TLSNotary is off from block 301
    // and back at R = 400; the re-enable release closes K1 at `validUntil`.
    const verdictsWithK1ClosedAt = (validUntil: number) => {
        getSharedState.forkConfig = cloneDefaultForkConfig()
        load({
            tlsnVerified: verified([key("old", K1, { validUntil }), key("next", K3, { validFrom: 400 })], 0),
            tlsnDisabled: { activationHeight: 300, reenableAt: 400 },
        })
        return [300, 301, 399, 400, 401, 499, 500].map(b => verdictFor(b, K1))
    }

    it("refuses the key from R on when it is closed at or below R, and trusts it again from R when closed above R", () => {
        for (const validUntil of [350, 400]) {
            expect(verdictsWithK1ClosedAt(validUntil)).toEqual(["verified", "disabled", "disabled", "refused", "refused", "refused", "refused"])
        }
        expect(verdictsWithK1ClosedAt(500)).toEqual(["verified", "disabled", "disabled", "verified", "verified", "verified", "refused"])
    })

    it("is the rule the runbook gives: close it no higher than R", () => {
        const runbook = readFileSync(new URL("../../docs/runbooks/tlsn-notary.md", import.meta.url), "utf8").replace(/\s+/g, " ")
        expect(runbook).toContain("Otherwise close it at a height the chain has not reached when the release ships and never above R")
        expect(runbook).toContain("a key closed above R is trusted again from R until its `validUntil`")
    })
})
