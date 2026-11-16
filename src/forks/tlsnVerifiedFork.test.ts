/**
 * The `tlsnVerified` fork ships dormant in the code and is scheduled at 0, with
 * its notary keys and verifier pin, by the mainnet genesis template, the
 * go/no-go fork list and the devnet genesis. Its payload is checked strictly
 * at load: a node that boots with a key list or verifier pin other than its
 * peers' would judge TLSNotary presentations differently.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { SigningKey } from "ethers"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { isForkActive } from "@/forks/forkGates"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { isTrustedNotaryKey, tlsnVerifiedParams } from "@/forks/tlsnVerifiedGate"
import { isSecp256k1CompressedPoint, tlsnVerifiedProblems } from "@/forks/tlsnVerifiedPayload"
import {
    VERIFIER_WASM_SHA256,
    notaryKeyHex,
    tlsnVerifiedPayload,
    uncompressedNotaryKeyHex,
} from "@/libs/blockchain/testSupport/tlsnVerifiedFixtures"
import { forkScheduleDigest, type ForkConfigLike } from "@/libs/peer/routines/forkScheduleAgreement"
import { getSharedState } from "@/utilities/sharedState"
import { LAUNCH_DORMANT_FORKS, MAINNET_FORKS } from "../../scripts/launch-go-no-go"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"
import template from "../../docs/mainnet/genesis.template.json"

// A P-256 public key (spike notary-a), compressed: well-formed hex, wrong curve
const P256_KEY = "038ba519e66dbd5289e83147e1e8e36835386240b02886fb96eee9603bca1e8e2c"

const load = (entry: Record<string, unknown>) =>
    loadForkConfigFromGenesis({ forks: { tlsnVerified: entry } })
const scheduled = (extra: Record<string, unknown> = {}) => ({ activationHeight: 100, ...tlsnVerifiedPayload(extra) })
const key = (hex: string, extra: Record<string, unknown> = {}) => ({ id: "n1", alg: "k256", hex, ...extra })

describe("tlsnVerified fork", () => {
    let saved: { forkConfig: ForkConfigByName; lastBlockNumber: number }

    beforeEach(() => {
        saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = saved.forkConfig
        getSharedState.lastBlockNumber = saved.lastBlockNumber
    })

    describe("config", () => {
        it("is dormant and carries no keys by default", () => {
            expect(DEFAULT_FORK_CONFIG.tlsnVerified.activationHeight).toBeNull()
            expect(DEFAULT_FORK_CONFIG.tlsnVerified.notaryKeys).toBeUndefined()
            expect(tlsnVerifiedParams(1_000_000)).toBeNull()
        })

        it("is copied, not shared, by the default clone", () => {
            const a = cloneDefaultForkConfig()
            a.tlsnVerified.activationHeight = 5
            expect(cloneDefaultForkConfig().tlsnVerified.activationHeight).toBeNull()
        })

        it("is scheduled at 0 by the mainnet template and the go/no-go list, with the kill switch unscheduled", () => {
            const forks = template.forks as Record<string, Record<string, unknown>>
            expect(forks.tlsnVerified.activationHeight).toBe(0)
            expect(forks.tlsnDisabled).toEqual({ activationHeight: null })
            expect(forks.tlsnProofEnforcement).toEqual({ activationHeight: 0 })
            expect(MAINNET_FORKS).toContain("tlsnVerified")
            expect(MAINNET_FORKS).not.toContain("tlsnDisabled")
            expect(LAUNCH_DORMANT_FORKS).toContain("tlsnDisabled")
        })

        it("loads from the devnet genesis active at 0, with its test keys and the kill switch off", () => {
            loadForkConfigFromGenesis(devnetGenesis)
            expect(isForkActive("tlsnVerified", 0)).toBe(true)
            expect(isForkActive("tlsnDisabled", 1_000_000)).toBe(false)
            const params = tlsnVerifiedParams(0)
            expect(params?.notaryKeys.map(k => k.id)).toEqual(["devnet-test-notary-1", "devnet-test-notary-2"])
        })
    })

    describe("payload validation at load", () => {
        it("accepts a complete payload", () => {
            load(scheduled())
            const c = getSharedState.forkConfig.tlsnVerified
            expect(c.activationHeight).toBe(100)
            expect(c.notaryKeys).toEqual(tlsnVerifiedPayload().notaryKeys as never)
            expect(c.verifierWasmSha256).toBe(VERIFIER_WASM_SHA256)
        })

        it("accepts an unscheduled entry without a payload, and holds a payload it carries to the same rules", () => {
            load({ activationHeight: null })
            expect(getSharedState.forkConfig.tlsnVerified.notaryKeys).toBeUndefined()
            load({ activationHeight: null, ...tlsnVerifiedPayload() })
            expect(getSharedState.forkConfig.tlsnVerified.notaryKeys).toHaveLength(2)
            expect(() => load({ activationHeight: null, ...tlsnVerifiedPayload({ notaryKeys: [] }) })).toThrow(
                ForkConfigValidationError,
            )
            expect(() => load({ activationHeight: null, maxPresentationBytes: 65536 })).toThrow(/notaryKeys/)
        })

        const refused: Array<[string, Record<string, unknown>, RegExp]> = [
            ["a scheduled entry without a payload", { activationHeight: 0 }, /notaryKeys must be a list/],
            ["no keys", scheduled({ notaryKeys: [] }), /notaryKeys must be a list of 1 to 8/],
            ["more than 8 keys", scheduled({ notaryKeys: Array.from({ length: 9 }, (_, i) => key(notaryKeyHex(i + 1), { id: `n${i}` })) }), /1 to 8/],
            ["a P-256 key", scheduled({ notaryKeys: [{ id: "n1", alg: "p256", hex: P256_KEY }] }), /alg must be "k256"/],
            ["an uncompressed key", scheduled({ notaryKeys: [key(uncompressedNotaryKeyHex(0x11))] }), /33-byte compressed secp256k1/],
            ["a 04-prefixed 66-hex key", scheduled({ notaryKeys: [key("04" + notaryKeyHex(0x11).slice(2))] }), /33-byte compressed/],
            ["an uppercase key", scheduled({ notaryKeys: [key(notaryKeyHex(0x11).toUpperCase())] }), /lowercase/],
            ["a 0x-prefixed key", scheduled({ notaryKeys: [key("0x" + notaryKeyHex(0x11))] }), /33-byte compressed/],
            // x = 5 is below the field prime but 5^3 + 7 has no square root mod p
            ["a key that is not a point", scheduled({ notaryKeys: [key("02" + "5".padStart(64, "0"))] }), /not a point on secp256k1/],
            ["a key whose x is not below the field prime", scheduled({ notaryKeys: [key("02" + "f".repeat(64))] }), /not a point on secp256k1/],
            [
                "a duplicate key",
                scheduled({ notaryKeys: [key(notaryKeyHex(0x11), { id: "a" }), key(notaryKeyHex(0x11), { id: "b" })] }),
                /repeats hex/,
            ],
            [
                "a duplicate id",
                scheduled({ notaryKeys: [key(notaryKeyHex(0x11)), key(notaryKeyHex(0x22))] }),
                /repeats id n1/,
            ],
            ["an empty id", scheduled({ notaryKeys: [key(notaryKeyHex(0x11), { id: "" })] }), /\.id must match/],
            ["an extra key field", scheduled({ notaryKeys: [key(notaryKeyHex(0x11), { fromHeight: 0 })] }), /unknown field "fromHeight"/],
            ["a key that is not an object", scheduled({ notaryKeys: [notaryKeyHex(0x11)] }), /must be an object/],
            ["a short wasm hash", scheduled({ verifierWasmSha256: "ab".repeat(31) }), /verifierWasmSha256/],
            ["an uppercase wasm hash", scheduled({ verifierWasmSha256: "AB".repeat(32) }), /verifierWasmSha256/],
            ["a FILL wasm hash", scheduled({ verifierWasmSha256: "FILL: sha256" }), /verifierWasmSha256/],
            ["an extra payload field", scheduled({ tlsnVersion: "0.1.0-alpha.12" }), /unknown field "tlsnVersion"/],
            ["a misspelt field", { ...scheduled(), futureSkewSecs: 60 }, /unknown field "futureSkewSecs"/],
            ["a presentation cap in KB", scheduled({ maxPresentationBytes: 64 }), /maxPresentationBytes must be an integer from 1024/],
            ["a fractional freshness window", scheduled({ freshnessWindowSec: 1.5 }), /freshnessWindowSec/],
            ["a zero freshness window", scheduled({ freshnessWindowSec: 0 }), /freshnessWindowSec/],
            ["a negative skew", scheduled({ futureSkewSec: -1 }), /futureSkewSec/],
            ["a skew as a string", scheduled({ futureSkewSec: "60" }), /futureSkewSec/],
        ]
        for (const [what, entry, why] of refused) {
            it(`refuses ${what}`, () => {
                expect(() => load(entry)).toThrow(ForkConfigValidationError)
                expect(() => load(entry)).toThrow(why)
            })
        }

        it("accepts a zero skew and both ends of every range", () => {
            load(scheduled({ futureSkewSec: 0, maxPresentationBytes: 1024, freshnessWindowSec: 1 }))
            load(scheduled({ futureSkewSec: 600, maxPresentationBytes: 1_048_576, freshnessWindowSec: 604_800 }))
            expect(() => load(scheduled({ futureSkewSec: 601 }))).toThrow(/futureSkewSec/)
        })

        it("reports every problem of an entry, not only the first", () => {
            const problems = tlsnVerifiedProblems(
                { activationHeight: 0, notaryKeys: [], verifierWasmSha256: "x", extra: 1 },
                true,
            )
            expect(problems.join("\n")).toContain("notaryKeys")
            expect(problems.join("\n")).toContain("verifierWasmSha256")
            expect(problems.join("\n")).toContain("unknown field \"extra\"")
            expect(problems.join("\n")).toContain("maxPresentationBytes")
        })
    })

    describe("secp256k1 point check", () => {
        it("accepts real keys of both parities and refuses x at or above the field prime", () => {
            const parities = new Set<string>()
            for (let b = 1; b < 40; b++) {
                const hex = notaryKeyHex(b)
                expect(isSecp256k1CompressedPoint(hex)).toBe(true)
                parities.add(hex.slice(0, 2))
            }
            expect([...parities].sort()).toEqual(["02", "03"])
            expect(isSecp256k1CompressedPoint("02" + "ff".repeat(32))).toBe(false)
            expect(isSecp256k1CompressedPoint("02fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f")).toBe(false)
        })

        it("agrees with ethers on which x below the field prime are points", () => {
            const verdicts = new Set<boolean>()
            for (let x = 1; x <= 64; x++) {
                for (const prefix of ["02", "03"]) {
                    const hex = prefix + x.toString(16).padStart(64, "0")
                    let point = true
                    try {
                        SigningKey.computePublicKey("0x" + hex)
                    } catch {
                        point = false
                    }
                    expect({ hex, point: isSecp256k1CompressedPoint(hex) }).toEqual({ hex, point })
                    verdicts.add(point)
                }
            }
            expect([...verdicts].sort()).toEqual([false, true])
        })
    })

    describe("tlsnVerifiedParams", () => {
        it("is null below the activation height and the payload from it on", () => {
            load(scheduled())
            expect(tlsnVerifiedParams(99)).toBeNull()
            const params = tlsnVerifiedParams(100)
            expect(params).toEqual(tlsnVerifiedPayload() as never)
            expect(tlsnVerifiedParams(1_000_000)).toEqual(params)
        })

        it("hands out a key list no caller can change", () => {
            load(scheduled())
            const keys = tlsnVerifiedParams(100)?.notaryKeys as unknown as Array<{ hex: string }>
            expect(() => keys.push(key(notaryKeyHex(0x33)))).toThrow()
            expect(() => {
                keys[0].hex = notaryKeyHex(0x33)
            }).toThrow()
            expect(tlsnVerifiedParams(100)?.notaryKeys[0].hex).toBe(notaryKeyHex(0x11))
        })

        it("throws when a hand-built config activates the fork without its payload", () => {
            getSharedState.forkConfig.tlsnVerified = { activationHeight: 0 }
            expect(() => tlsnVerifiedParams(5)).toThrow(/without its payload/)
        })

        it("trusts only a listed k256 key, and only where the fork is active", () => {
            load(scheduled())
            const listed = notaryKeyHex(0x22)
            expect(isTrustedNotaryKey(99, "k256", listed)).toBe(false)
            expect(isTrustedNotaryKey(100, "k256", listed)).toBe(true)
            expect(isTrustedNotaryKey(100, "k256", listed.toUpperCase())).toBe(true)
            expect(isTrustedNotaryKey(100, "p256", listed)).toBe(false)
            expect(isTrustedNotaryKey(100, "k256", notaryKeyHex(0x33))).toBe(false)
        })
    })

    describe("schedule agreement", () => {
        it("puts the notary keys and the verifier pin in the fork schedule digest", () => {
            load(scheduled())
            const a = forkScheduleDigest(getSharedState.forkConfig as unknown as ForkConfigLike, 7)
            load(scheduled({ notaryKeys: [key(notaryKeyHex(0x33))] }))
            const b = forkScheduleDigest(getSharedState.forkConfig as unknown as ForkConfigLike, 7)
            load(scheduled({ verifierWasmSha256: "cd".repeat(32) }))
            const c = forkScheduleDigest(getSharedState.forkConfig as unknown as ForkConfigLike, 7)
            expect(new Set([a, b, c]).size).toBe(3)
        })

        it("leaves the digest of a genesis that does not schedule it unchanged", () => {
            const without = cloneDefaultForkConfig() as unknown as Record<string, unknown>
            const { tlsnVerified: _t, ...rest } = without
            expect(forkScheduleDigest(without as ForkConfigLike, 1)).toBe(forkScheduleDigest(rest as ForkConfigLike, 1))
        })
    })
})
