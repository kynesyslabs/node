import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

/**
 * DACS per-operation authorization.
 *
 * This is a binding, not substrate: the envelope it builds names a network,
 * rail, job and phase, which are DACS concepts. The substrate only knows that
 * an operation declares `requiredRoles` and that something must cover them.
 *
 * Every operation names `requiredRoles`; each (operation, role) pair must be
 * covered by exactly one signed authorization whose envelope binds the Work
 * identity, the operation identity, the role, and the roster signer for that
 * role. This module is the pure envelope-binding + coverage layer plus the
 * authorization hash; ed25519 signature verification is injected (the node wires
 * its own verifier) so this stays dependency-light and unit-testable.
 *
 * Ports the reference `verify_authorizations` structural checks + `authorization_hash`.
 */

import { DACS_DOMAINS } from "@/libs/atomic-work/dacs/domains"
import { DACS_ROLES } from "@/libs/atomic-work/dacs/profile"

/** Signature domain: signatures are over AUTH_DOMAIN ‖ authorizationHash(ascii). */
export const AUTH_DOMAIN: string = DACS_DOMAINS.authorization

/** Canonical role evaluation order. */
export const ROLE_ORDER: readonly string[] = DACS_ROLES

/** authorizationHash = sha256(JCS(authorization without its `value` signature)). */
export function computeAuthorizationHash(
    authorization: Record<string, unknown>,
): string {
    const { value: _omit, ...unsigned } = authorization
    return Hashing.sha256Bytes(Buffer.from(jcsCanonicalize(unsigned), "utf-8"))
}

/** Everything an injected verifier needs to check one authorization. */
export interface AuthorizationSignatureInput {
    /** The roster signer claim the envelope binds this role to. */
    signer: unknown
    /** The exact bytes covered by the signature. */
    signedBytes: string
    /** The signature as submitted. */
    signature: string
}

export interface AuthorizationEnvelope {
    authorizationVersion: "1"
    workId: string
    executionProfile: string
    networkId: string
    railId: string
    jobId: string
    phaseIndex: number
    operationId: string
    operationIndex: number
    operationKind: string
    role: string
    signer: unknown
}

export interface AuthzOperation {
    operationId: string
    kind: string
    requiredRoles: string[]
}
export interface AuthzIntent {
    executionProfile: string
    networkId: string
    railId: string
    jobId: string
    phaseIndex: number
    operations: AuthzOperation[]
    roleRoster: { role: string; signer: unknown }[]
}

export class AuthorizationError extends Error {
    constructor(
        message: string,
        readonly reason:
            | "envelope-mismatch"
            | "unexpected-or-duplicate"
            | "missing-authorization"
            | "bad-algorithm"
            | "bad-signature",
    ) {
        super(message)
        this.name = "AuthorizationError"
    }
}

/** The exact authorization envelope required for one (operation, role) pair. */
export function buildExpectedEnvelope(
    intent: AuthzIntent,
    operationIndex: number,
    role: string,
    workId: string,
): AuthorizationEnvelope {
    const op = intent.operations[operationIndex]
    const roster = new Map(intent.roleRoster.map(r => [r.role, r.signer]))
    return {
        authorizationVersion: "1",
        workId,
        executionProfile: intent.executionProfile,
        networkId: intent.networkId,
        railId: intent.railId,
        jobId: intent.jobId,
        phaseIndex: intent.phaseIndex,
        operationId: op.operationId,
        operationIndex,
        operationKind: op.kind,
        role,
        signer: roster.get(role),
    }
}

function canonicalEq(a: unknown, b: unknown): boolean {
    return jcsCanonicalize(a as never) === jcsCanonicalize(b as never)
}

/**
 * Verify per-operation authorization coverage + envelope binding for an intent.
 *
 * Enforces (byte-for-byte with the reference):
 *  - the set of (operationIndex, role) authorizations equals exactly the set
 *    required by every operation's `requiredRoles` — none missing, extra, or
 *    duplicated;
 *  - each authorization's envelope matches the derived expected envelope
 *    (Work + operation identity + role + roster signer) and `algorithm==="ed25519"`.
 *
 * `verifySignature`, if provided, is called per authorization with everything
 * a verifier needs: the signer claim, the exact bytes that were signed, and the
 * signature carried by the authorization. Returning false rejects. Omit it to
 * check only structure and coverage — the node injects its ed25519 verifier.
 *
 * An authorization with no signature value is rejected before the callback
 * runs: a verifier handed an empty signature has nothing to check, and a
 * permissive one would then pass it.
 */
export function verifyAuthorizationCoverage(
    intent: AuthzIntent,
    authorizations: Record<string, unknown>[],
    workId: string,
    verifySignature?: (input: AuthorizationSignatureInput) => boolean,
): void {
    const expectedPairs = new Set<string>()
    intent.operations.forEach((op, i) => {
        for (const role of op.requiredRoles) expectedPairs.add(`${i}:${role}`)
    })

    const seen = new Set<string>()
    for (const authorization of authorizations) {
        const index = authorization.operationIndex
        const role = authorization.role
        if (
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= intent.operations.length
        )
            throw new AuthorizationError("invalid authorization operationIndex", "envelope-mismatch")
        if (authorization.algorithm !== "ed25519")
            throw new AuthorizationError("authorization algorithm not supported", "bad-algorithm")

        const expected = buildExpectedEnvelope(intent, index, role as string, workId)
        for (const [field, want] of Object.entries(expected)) {
            const got = authorization[field]
            const ok =
                field === "signer" ? canonicalEq(got, want) : got === want
            if (!ok)
                throw new AuthorizationError(
                    `authorization envelope mismatch: ${field}`,
                    "envelope-mismatch",
                )
        }

        const pair = `${index}:${role}`
        if (!expectedPairs.has(pair) || seen.has(pair))
            throw new AuthorizationError(
                "unexpected or duplicate operation authorization",
                "unexpected-or-duplicate",
            )

        if (verifySignature) {
            const signature = authorization.value
            if (typeof signature !== "string" || signature.length === 0)
                throw new AuthorizationError(
                    "operation authorization carries no signature value",
                    "bad-signature",
                )
            const signedBytes =
                AUTH_DOMAIN + computeAuthorizationHash(authorization)
            if (!verifySignature({ signer: authorization.signer, signedBytes, signature }))
                throw new AuthorizationError(
                    "invalid operation authorization signature",
                    "bad-signature",
                )
        }
        seen.add(pair)
    }

    if (seen.size !== expectedPairs.size)
        throw new AuthorizationError(
            "missing required operation authorization",
            "missing-authorization",
        )
}
