import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    AUTH_DOMAIN,
    ROLE_ORDER,
    computeAuthorizationHash,
    verifyAuthorizationCoverage,
    AuthorizationError,
    type AuthorizationSignatureInput,
    type AuthzIntent,
} from "@/libs/atomic-work/dacs/authorization"

// Authorization fixtures from #336 pass vectors (DACS-Standard @ 6a4dd2a):
// self-validated authorization_hash cases + full coverage cases (intent envelope
// + roleRoster + the operation authorizations).
type AuthzFixture = {
    authDomain: string
    roleOrder: string[]
    hashCases: { authorization: Record<string, unknown>; authorizationHash: string }[]
    coverageCases: { intent: AuthzIntent & { workId: string }; authorizations: Record<string, unknown>[] }[]
}
const fx: AuthzFixture = JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__/authorization.vectors.json"), "utf-8"),
)

describe("authorization hash — reconciliation vs #336", () => {
    it("pins the AUTH domain + role order", () => {
        expect(AUTH_DOMAIN).toBe(fx.authDomain)
        expect([...ROLE_ORDER]).toEqual(fx.roleOrder)
    })

    for (const [i, c] of fx.hashCases.entries()) {
        it(`reproduces authorization_hash [case ${i}]`, () => {
            expect(computeAuthorizationHash(c.authorization)).toBe(c.authorizationHash)
        })
    }

    it("excludes the `value` signature from the hash", () => {
        const a = fx.hashCases[0].authorization
        const tampered = { ...a, value: "different-signature" }
        expect(computeAuthorizationHash(tampered)).toBe(computeAuthorizationHash(a))
    })
})

describe("authorization coverage — reconciliation vs #336", () => {
    for (const [i, c] of fx.coverageCases.entries()) {
        it(`accepts the published authorization set [case ${i}]`, () => {
            expect(() =>
                verifyAuthorizationCoverage(c.intent, c.authorizations, c.intent.workId),
            ).not.toThrow()
        })
    }

    it("rejects a missing authorization", () => {
        const c = fx.coverageCases[0]
        expect(() =>
            verifyAuthorizationCoverage(c.intent, c.authorizations.slice(1), c.intent.workId),
        ).toThrow(/missing/)
    })

    it("rejects a duplicate authorization", () => {
        const c = fx.coverageCases[0]
        const dup = [...c.authorizations, c.authorizations[0]]
        expect(() => verifyAuthorizationCoverage(c.intent, dup, c.intent.workId)).toThrow(
            AuthorizationError,
        )
    })

    it("rejects a tampered envelope field (wrong workId)", () => {
        const c = fx.coverageCases[0]
        expect(() =>
            verifyAuthorizationCoverage(c.intent, c.authorizations, "f".repeat(64)),
        ).toThrow(/envelope mismatch/)
    })

    it("rejects a non-ed25519 algorithm", () => {
        const c = fx.coverageCases[0]
        const bad = c.authorizations.map((a, i) =>
            i === 0 ? { ...a, algorithm: "secp256k1" } : a,
        )
        expect(() => verifyAuthorizationCoverage(c.intent, bad, c.intent.workId)).toThrow(
            /algorithm/,
        )
    })

    it("invokes the injected signature verifier over AUTH_DOMAIN‖hash", () => {
        const c = fx.coverageCases[0]
        const seen: string[] = []
        verifyAuthorizationCoverage(c.intent, c.authorizations, c.intent.workId, input => {
            seen.push(input.signedBytes)
            return true
        })
        expect(seen.length).toBe(c.authorizations.length)
        expect(seen.every(d => d.startsWith(AUTH_DOMAIN))).toBe(true)
    })

    it("rejects when the injected signature verifier fails", () => {
        const c = fx.coverageCases[0]
        expect(() =>
            verifyAuthorizationCoverage(c.intent, c.authorizations, c.intent.workId, () => false),
        ).toThrow(/signature/)
    })
})

describe("the injected signature verifier", () => {
    /**
     * The callback used to receive only the signer and the digest, so it could
     * not actually verify anything — an ed25519 check needs the signature too.
     * A node wiring its verifier in would have had to either fabricate a pass
     * or reach around this function for the value.
     */
    function firstCoverageCase() {
        const fixture = JSON.parse(
            readFileSync(join(import.meta.dir, "__fixtures__", "authorization.vectors.json"), "utf8"),
        )
        const testCase = fixture.coverageCases[0]
        return { ...testCase, workId: testCase.authorizations[0].workId }
    }

    it("receives the signer, the signed bytes and the signature", () => {
        const fx = firstCoverageCase()
        const seen: AuthorizationSignatureInput[] = []

        try {
            verifyAuthorizationCoverage(
                fx.intent,
                fx.authorizations,
                fx.workId,
                input => {
                    seen.push(input)
                    return true
                },
            )
        } catch {
            // Coverage may fail for unrelated fixture reasons; what matters is
            // what the callback was handed before that.
        }

        expect(seen.length).toBeGreaterThan(0)
        expect(seen[0].signature).toBeTruthy()
        expect(seen[0].signedBytes).toContain(AUTH_DOMAIN)
        expect(seen[0].signer).toBeDefined()
    })

    it("refuses an authorization carrying no signature at all", () => {
        const fx = firstCoverageCase()
        const stripped = fx.authorizations.map((a: Record<string, unknown>) => ({
            ...a,
            value: "",
        }))

        expect(() =>
            verifyAuthorizationCoverage(fx.intent, stripped, fx.workId, () => true),
        ).toThrow(/no signature value/)
    })
})
