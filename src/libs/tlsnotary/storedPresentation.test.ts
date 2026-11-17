/**
 * The presentation checks of a `tlsn_store` under `tlsnVerified`: the
 * presentation gate every TLSN verdict goes through, then the store's
 * transcript rules (bind header, revealed credentials). The verifier is
 * replaced by one that returns a vector's recorded output, or a transcript
 * built here; the verifier itself is covered by its own suite.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { setPresentationVerifierForTests } from "./presentationGate"
import { verifyStoredPresentation } from "./storedPresentation"
import { TlsnVerifierUnavailableError } from "./wasmVerifier"

const VECTORS = join(import.meta.dir, "../../../testing/tlsn-vectors")
const vector = (name: string) => JSON.parse(readFileSync(join(VECTORS, name, "output.json"), "utf8"))
const FAKE_WASM_SHA256 = "ef".repeat(32)
const trustedKeys: { alg: string; publicKey: string }[] = JSON.parse(
    readFileSync(join(VECTORS, "trusted-notary-keys.json"), "utf8"),
)

// What the stand-in verifier returns for the next call; null fails it.
let nextOutput: Record<string, unknown> | null = null
let calls = 0

const SENDER = "0x" + "11".repeat(32)
// As the SDK names it, and the chain keys the token: no 0x.
const REQUEST = "22".repeat(32)
const SERVER = "api.demos-spike.test"

/**
 * `out` with its github bind header rewritten to bind a store, ranges
 * shifted to match. `sdkForm` drops the 0x the vectors put on the request
 * hash, as the SDK writes it (sdks#194).
 */
function asStore(out: Record<string, any>, sdkForm = true): Record<string, any> {
    const sent = Buffer.from(out.sent, "hex").toString("latin1")
    const from = "demos-tlsn:v1:github:"
    const at = sent.indexOf(from)
    expect(at).toBeGreaterThan(-1)
    let rewritten = sent.replace(from, "demos-tlsn:v1:store:")
    if (sdkForm) rewritten = rewritten.replace(`:0x${REQUEST}\r\n`, `:${REQUEST}\r\n`)
    expect(rewritten).not.toBe(sent)
    const shift = rewritten.length - sent.length
    return {
        ...out,
        sent: Buffer.from(rewritten, "latin1").toString("hex"),
        sentAuthed: out.sentAuthed.map(([s, e]: [number, number]) => [s > at ? s + shift : s, e > at ? e + shift : e]),
    }
}

/** `text` as the verifier reports it with the substrings `hidden` redacted. */
function partly(text: string, ...hidden: string[]): { hex: string; authed: [number, number][] } {
    const bytes = Buffer.from(text, "latin1")
    const cuts = hidden
        .map(h => {
            const at = text.indexOf(h)
            expect(at).toBeGreaterThan(-1)
            return [at, at + h.length] as [number, number]
        })
        .sort((a, b) => a[0] - b[0])
    const authed: [number, number][] = []
    let at = 0
    for (const [from, to] of cuts) {
        if (from > at) authed.push([at, from])
        bytes.fill(0, from, to)
        at = to
    }
    if (at < bytes.length) authed.push([at, bytes.length])
    return { hex: bytes.toString("hex"), authed }
}

const BIND = `x-demos-bind: demos-tlsn:v1:store:${SENDER}:${REQUEST}\r\n`
const REQUEST_HEAD = `GET /x HTTP/1.1\r\nhost: ${SERVER}\r\nauthorization: Bearer s3cret\r\n${BIND}\r\n`
const RESPONSE = "HTTP/1.1 200 OK\r\nset-cookie: s=1\r\ncontent-length: 7\r\n\r\n{\"a\":1}"

/** The k256 vector's attestation over a transcript built here. */
function over(
    sent: { hex: string; authed: [number, number][] },
    recv = partly(RESPONSE, "s=1"),
): Record<string, any> {
    return {
        ...vector("valid-local-k256"),
        sent: sent.hex,
        sentAuthed: sent.authed,
        recv: recv.hex,
        recvAuthed: recv.authed,
    }
}

const proofOf = (bytes = 64) =>
    JSON.stringify({ version: "0.1.0-alpha.12", data: "ab".repeat(bytes), meta: { notaryUrl: "x" } })

const savedForks = getSharedState.forkConfig
const savedTip = getSharedState.lastBlockNumber

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    const forks = getSharedState.forkConfig as any
    forks.tlsnVerified = {
        ...forks.tlsnVerified,
        activationHeight: 0,
        notaryKeys: trustedKeys.map((k, i) => ({ id: `vector-${i}`, alg: k.alg, hex: k.publicKey })),
        verifierWasmSha256: FAKE_WASM_SHA256,
        maxPresentationBytes: 4096,
        freshnessWindowSec: 3600,
        futureSkewSec: 60,
    }
    getSharedState.lastBlockNumber = 100
    nextOutput = null
    calls = 0
    setPresentationVerifierForTests({
        wasmSha256: FAKE_WASM_SHA256,
        verify: () => {
            calls++
            return (nextOutput ? { ok: true, raw: "", out: nextOutput } : { ok: false }) as never
        },
    })
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedTip
    setPresentationVerifierForTests(null)
})

const input = (extra: Partial<Parameters<typeof verifyStoredPresentation>[0]> = {}) => ({
    proof: proofOf(),
    sender: SENDER,
    requestTxHash: REQUEST,
    tip: 100,
    blockTimeSec: vector("valid-local-k256").time,
    ...extra,
})

const reasonOf = (verdict: ReturnType<typeof verifyStoredPresentation>) => (verdict.ok === false ? verdict.reason : "")

describe("verifyStoredPresentation", () => {
    it("accepts the vector bound to this store, and stores it without its meta", () => {
        nextOutput = asStore(vector("valid-local-k256"))

        const verdict = verifyStoredPresentation(input({ proof: proofOf().replace(/ab/g, "AB") }))

        expect(verdict).toEqual({
            ok: true,
            attestationId: vector("valid-local-k256").attestationId,
            serverName: SERVER,
            attestedTimeSec: vector("valid-local-k256").time,
            canonicalProof: JSON.stringify({ version: "0.1.0-alpha.12", data: "ab".repeat(64) }),
        })
    })

    it("refuses the vector as recorded: it is bound to an identity context, not a store", () => {
        nextOutput = vector("valid-local-k256")
        expect(verifyStoredPresentation(input()).ok).toBe(false)
    })

    it("refuses a bind that writes the request hash with 0x: one request has one bind value", () => {
        nextOutput = asStore(vector("valid-local-k256"), false)
        expect(reasonOf(verifyStoredPresentation(input()))).toContain("X-Demos-Bind header is malformed")
    })

    it("refuses another sender and another request", () => {
        nextOutput = asStore(vector("valid-local-k256"))
        expect(reasonOf(verifyStoredPresentation(input({ sender: "0x" + "33".repeat(32) })))).toContain(
            "another account",
        )
        expect(reasonOf(verifyStoredPresentation(input({ requestTxHash: "44".repeat(32) })))).toContain(
            "another tlsn_request",
        )
    })

    it("refuses a P-256 notary, a notary key the fork does not list, and an unnamed server", () => {
        nextOutput = asStore(vector("valid-local"))
        expect(reasonOf(verifyStoredPresentation(input()))).toContain("k256")
        nextOutput = { ...asStore(vector("valid-local-k256")), verifyingKey: { alg: "k256", hex: "02" + "ab".repeat(32) } }
        expect(reasonOf(verifyStoredPresentation(input()))).toContain("notary key")
        nextOutput = { ...asStore(vector("valid-local-k256")), serverName: null }
        expect(reasonOf(verifyStoredPresentation(input()))).toContain("server identity")
    })

    it("judges freshness against the block time", () => {
        nextOutput = asStore(vector("valid-local-k256"))
        const t = vector("valid-local-k256").time
        expect(verifyStoredPresentation(input({ blockTimeSec: t + 3600 })).ok).toBe(true)
        expect(verifyStoredPresentation(input({ blockTimeSec: t + 3601 })).ok).toBe(false)
        expect(verifyStoredPresentation(input({ blockTimeSec: t - 60 })).ok).toBe(true)
        expect(verifyStoredPresentation(input({ blockTimeSec: t - 61 })).ok).toBe(false)
    })

    it("refuses a presentation that does not verify", () => {
        expect(reasonOf(verifyStoredPresentation(input()))).toContain("does not verify")
    })

    describe("the transcript of a store", () => {
        it("accepts a hidden credential value, a hidden Set-Cookie value and a body revealed in part", () => {
            nextOutput = over(partly(REQUEST_HEAD, "Bearer s3cret"), partly(RESPONSE, "s=1", "\"a\""))
            expect(verifyStoredPresentation(input()).ok).toBe(true)
        })

        it("refuses a revealed Authorization value", () => {
            nextOutput = over(partly(REQUEST_HEAD))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("reveals the authorization header value")
        })

        it("refuses a credential value revealed in part", () => {
            nextOutput = over(partly(REQUEST_HEAD, "s3cret"))
            expect(verifyStoredPresentation(input()).ok).toBe(false)
        })

        it("refuses a revealed Set-Cookie value", () => {
            nextOutput = over(partly(REQUEST_HEAD, "Bearer s3cret"), partly(RESPONSE))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("reveals the set-cookie response header value")
        })

        it("refuses a response whose head is not revealed", () => {
            nextOutput = over(partly(REQUEST_HEAD, "Bearer s3cret"), partly(RESPONSE, "HTTP/1.1 200 OK\r\n"))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("response:")
        })

        it("refuses a second request after the head, revealed or not", () => {
            const two = REQUEST_HEAD + "GET / HTTP/1.1\r\nauthorization: Bearer s3cret\r\n\r\n"
            nextOutput = over(partly(two, "Bearer s3cret"))
            expect(verifyStoredPresentation(input()).ok).toBe(false)
            nextOutput = over(partly(two, "Bearer s3cret", "GET / HTTP/1.1\r\nauthorization: Bearer s3cret\r\n\r\n"))
            expect(verifyStoredPresentation(input()).ok).toBe(false)
        })

        it("accepts a POST whose Content-Length body is hidden, and refuses a request smuggled after it", () => {
            const post = REQUEST_HEAD.replace("GET /x", "POST /x").replace(BIND, `${BIND}content-length: 9\r\n`)
            nextOutput = over(partly(post + "{\"pin\":1}", "Bearer s3cret", "{\"pin\":1}"))
            expect(verifyStoredPresentation(input()).ok).toBe(true)
            nextOutput = over(partly(post + "{\"pin\":1}GET / HTTP/1.1\r\n\r\n", "Bearer s3cret", "{\"pin\":1}"))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("does not end the sent transcript")
        })

        it("refuses a second response after the one the request was answered with", () => {
            const two = RESPONSE + "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"
            nextOutput = over(partly(REQUEST_HEAD, "Bearer s3cret"), partly(two, "s=1"))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("does not end the transcript")
        })

        it("refuses a hidden header name next to a revealed value", () => {
            nextOutput = over(partly(REQUEST_HEAD, "authorization"))
            expect(verifyStoredPresentation(input()).ok).toBe(false)
        })

        it("refuses a hidden or repeated bind header", () => {
            nextOutput = over(partly(REQUEST_HEAD, "Bearer s3cret", `demos-tlsn:v1:store:${SENDER}:${REQUEST}`))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("X-Demos-Bind header is not fully revealed")
            nextOutput = over(partly(REQUEST_HEAD, "Bearer s3cret", REQUEST))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("partly revealed")
            const twice = REQUEST_HEAD.replace(BIND, BIND + BIND)
            nextOutput = over(partly(twice, "Bearer s3cret"))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("repeated")
        })

        it("refuses a Host other than the attested server", () => {
            nextOutput = over(partly(REQUEST_HEAD.replace(`host: ${SERVER}`, "host: example.com"), "Bearer s3cret"))
            expect(reasonOf(verifyStoredPresentation(input()))).toContain("request Host")
        })
    })

    describe("before the verifier runs", () => {
        const cases: [string, string][] = [
            ["a proof over the cap", proofOf(4097)],
            ["an envelope over the cap", proofOf(4096) + " ".repeat(5000)],
            ["a proof that is not JSON", "nope"],
            ["a proof that is an array", "[]"],
            ["a proof with no version", JSON.stringify({ data: "abcd" })],
            ["a proof whose data is not hex", JSON.stringify({ version: "1", data: "zz" })],
            ["a proof whose data is odd-length hex", JSON.stringify({ version: "1", data: "abc" })],
            ["a proof with no data", JSON.stringify({ version: "1", data: "" })],
        ]
        for (const [name, proof] of cases) {
            it(`refuses ${name}`, () => {
                nextOutput = asStore(vector("valid-local-k256"))
                expect(verifyStoredPresentation(input({ proof })).ok).toBe(false)
                expect(calls).toBe(0)
            })
        }

        it("accepts a proof at exactly the cap", () => {
            nextOutput = asStore(vector("valid-local-k256"))
            expect(verifyStoredPresentation(input({ proof: proofOf(4096) })).ok).toBe(true)
        })
    })

    it("gives no verdict when the chain pins another verifier build", () => {
        getSharedState.forkConfig.tlsnVerified.verifierWasmSha256 = "01".repeat(32)
        expect(() => verifyStoredPresentation(input())).toThrow(TlsnVerifierUnavailableError)
    })

    it("gives no verdict when the fork is not active at the tip", () => {
        getSharedState.forkConfig.tlsnVerified.activationHeight = null
        expect(() => verifyStoredPresentation(input())).toThrow()
    })
})
