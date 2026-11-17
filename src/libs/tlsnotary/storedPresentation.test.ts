/**
 * The presentation checks of a `tlsn_store` under `tlsnVerified`, on the
 * verifier output of the checked-in vectors: the bind header, the redacted
 * credential, the caps, and the refusals a presentation that verifies can
 * still earn. The wasm verifier is replaced by one that returns the vector's
 * recorded output; the verifier itself is covered by its own suite.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const VECTORS = join(import.meta.dir, "../../../testing/tlsn-vectors")
const vector = (name: string) => JSON.parse(readFileSync(join(VECTORS, name, "output.json"), "utf8"))
const FAKE_WASM_SHA256 = "ef".repeat(32)

// What the stand-in verifier returns for the next call; null fails it.
let nextOutput: Record<string, unknown> | null = null
let calls = 0
class FakeVerifierError extends Error {}
mock.module("@/libs/tlsnotary/wasmVerifier", () => ({
    __esModule: true,
    TLSN_MAX_PRESENTATION_BYTES: 1 << 20,
    TLSN_VERIFY_WASM_SHA256: FAKE_WASM_SHA256,
    TlsnVerifierUnavailableError: FakeVerifierError,
    TlsnVerifierLoadError: FakeVerifierError,
    verifyPresentation: () => {
        calls++
        return nextOutput ? { ok: true, raw: "", out: nextOutput } : { ok: false }
    },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { readBindHeader, revealedSecretHeader, verifyStoredPresentation } from "./storedPresentation"

const SENDER = "0x" + "11".repeat(32)
const REQUEST = "0x" + "22".repeat(32)
const trustedKeys: { alg: string; publicKey: string }[] = JSON.parse(
    readFileSync(join(VECTORS, "trusted-notary-keys.json"), "utf8"),
)

/**
 * `out` with its github bind header rewritten to bind a store, ranges shifted
 * to match. `sdkForm` drops the 0x of the request hash, as the SDK writes it.
 */
function asStore(out: Record<string, any>, sdkForm = false): Record<string, any> {
    const sent = Buffer.from(out.sent, "hex").toString("latin1")
    const from = "demos-tlsn:v1:github:"
    const at = sent.indexOf(from)
    expect(at).toBeGreaterThan(-1)
    let rewritten = sent.replace(from, "demos-tlsn:v1:store:")
    if (sdkForm) rewritten = rewritten.replace(`:${REQUEST}\r\n`, `:${REQUEST.slice(2)}\r\n`)
    expect(rewritten).not.toBe(sent)
    const shift = rewritten.length - sent.length
    return {
        ...out,
        sent: Buffer.from(rewritten, "latin1").toString("hex"),
        sentAuthed: out.sentAuthed.map(([s, e]: [number, number]) => [s > at ? s + shift : s, e > at ? e + shift : e]),
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
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedTip
})

describe("readBindHeader", () => {
    it("reads the bind header a vector reveals", () => {
        const bind = readBindHeader(vector("valid-local"))
        expect(bind).toEqual({ ok: true, bind: { context: "github", sender: SENDER, requestTxHash: REQUEST } })
    })

    it("refuses a bind header that is not wholly authenticated", () => {
        const out = vector("valid-local")
        const cut = { ...out, sentAuthed: [[0, 167], [211, 300]] }
        expect(readBindHeader(cut).ok).toBe(false)
    })

    it("refuses two bind headers", () => {
        const out = vector("valid-github")
        const sent = Buffer.from(out.sent, "hex").toString("latin1")
        const line = sent.slice(sent.indexOf("x-demos-bind"), sent.indexOf("\r\n\r\n") + 2)
        const twice = Buffer.from(sent.replace(line, line + line), "latin1")
        expect(readBindHeader({ sent: twice.toString("hex"), sentAuthed: [[0, twice.length]] }).ok).toBe(false)
    })

    it("refuses a malformed bind value", () => {
        const sent = Buffer.from("GET / HTTP/1.1\r\nx-demos-bind: demos-tlsn:v2:store:a:b\r\n\r\n", "latin1")
        expect(readBindHeader({ sent: sent.toString("hex"), sentAuthed: [[0, sent.length]] }).ok).toBe(false)
    })
})

describe("revealedSecretHeader", () => {
    it("finds no secret when the Authorization value is redacted", () => {
        expect(revealedSecretHeader(vector("valid-local"))).toBeNull()
    })

    /** A head whose bytes outside `hidden` (substrings of it) are authenticated, as the verifier reports it. */
    function partly(head: string, ...hidden: string[]) {
        const sent = Buffer.from(head, "latin1")
        const cuts = hidden
            .map(h => {
                const at = head.indexOf(h)
                expect(at).toBeGreaterThan(-1)
                return [at, at + h.length] as [number, number]
            })
            .sort((a, b) => a[0] - b[0])
        const ranges: [number, number][] = []
        let at = 0
        for (const [from, to] of cuts) {
            if (from > at) ranges.push([at, from])
            sent.fill(0, from, to)
            at = to
        }
        if (at < sent.length) ranges.push([at, sent.length])
        return { sent: sent.toString("hex"), sentAuthed: ranges }
    }
    const HEAD = "GET / HTTP/1.1\r\nhost: a.test\r\nx-note: hi\r\nauthorization: Bearer s3cret\r\nx-demos-bind: b\r\n\r\n"

    it("accepts a secret header whose value alone is hidden", () => {
        expect(revealedSecretHeader(partly(HEAD, "Bearer s3cret"))).toBeNull()
    })

    it("refuses a hidden header name over a revealed value", () => {
        expect(revealedSecretHeader(partly(HEAD, "authorization"))).not.toBeNull()
        expect(revealedSecretHeader(partly(HEAD, "author"))).not.toBeNull()
    })

    it("refuses a hidden colon or CRLF that would hide a secret header in another line", () => {
        expect(revealedSecretHeader(partly(HEAD, "authorization:"))).not.toBeNull()
        expect(revealedSecretHeader(partly(HEAD, "hi\r\n"))).not.toBeNull()
    })

    it("refuses a value revealed only in part", () => {
        expect(revealedSecretHeader(partly(HEAD, "s3cret"))).not.toBeNull()
        expect(revealedSecretHeader(partly(HEAD, "a.test"))).not.toBeNull()
    })

    it("accepts a line hidden up to its CRLF, and refuses one whose CRLF is hidden too", () => {
        expect(revealedSecretHeader(partly(HEAD, "authorization: Bearer s3cret"))).toBeNull()
        // Its zeros then lead the next line, whose name can no longer be read.
        expect(revealedSecretHeader(partly(HEAD, "authorization: Bearer s3cret\r\n"))).not.toBeNull()
    })

    it("refuses a hidden CRLF that folds a header into the request line", () => {
        const head = "GET / HTTP/1.1\r\nauthorization: Bearer s3cret\r\nhost: a.test\r\n\r\n"
        expect(revealedSecretHeader(partly(head, "HTTP/1.1\r\n"))).not.toBeNull()
        expect(revealedSecretHeader(partly(head, "1\r\n"))).not.toBeNull()
    })

    it("accepts a request line that hides only its target", () => {
        const head = "GET /user?key=abc HTTP/1.1\r\nhost: a.test\r\n\r\n"
        expect(revealedSecretHeader(partly(head, "/user?key=abc"))).toBeNull()
        expect(revealedSecretHeader(partly(head, "GET /user?key=abc HTTP/1.1"))).not.toBeNull()
    })

    it("refuses a second request revealed after the head", () => {
        const two = "GET / HTTP/1.1\r\nhost: a.test\r\n\r\nGET / HTTP/1.1\r\nauthorization: Bearer s3cret\r\n\r\n"
        expect(revealedSecretHeader(partly(two))).not.toBeNull()
        // Hidden whole, it reveals nothing.
        expect(revealedSecretHeader(partly(two, "GET / HTTP/1.1\r\nauthorization: Bearer s3cret\r\n\r\n"))).toBeNull()
    })

    it("accepts a revealed body of the declared length", () => {
        const body = '{"q":1}'
        const head = `POST / HTTP/1.1\r\nhost: a.test\r\ncontent-length: ${body.length}\r\n\r\n${body}`
        expect(revealedSecretHeader(partly(head))).toBeNull()
        expect(revealedSecretHeader(partly(head + "GET / HTTP/1.1\r\n\r\n"))).not.toBeNull()
    })

    it("names the Authorization header when its value is authenticated", () => {
        const out = vector("valid-local")
        expect(revealedSecretHeader({ ...out, sentAuthed: [[0, out.transcriptLength.sent]] })).toBe("authorization")
    })
})

describe("verifyStoredPresentation", () => {
    const input = (extra: Partial<Parameters<typeof verifyStoredPresentation>[0]> = {}) => ({
        proof: proofOf(),
        sender: SENDER,
        requestTxHash: REQUEST,
        tip: 100,
        blockTimeSec: vector("valid-local").time,
        ...extra,
    })

    it("accepts the vector bound to this store, and stores it without its meta", () => {
        nextOutput = asStore(vector("valid-local"))

        const verdict = verifyStoredPresentation(input({ proof: proofOf().replace(/ab/g, "AB") }))

        expect(verdict).toEqual({
            ok: true,
            attestationId: vector("valid-local").attestationId,
            serverName: "api.demos-spike.test",
            attestedTimeSec: vector("valid-local").time,
            canonicalProof: JSON.stringify({ version: "0.1.0-alpha.12", data: "ab".repeat(64) }),
        })
    })

    it("accepts the bind value in the SDK's form: sender with 0x, request hash without", () => {
        const out = asStore(vector("valid-local"), true)
        const sent = Buffer.from(out.sent, "hex").toString("latin1")
        expect(sent).toContain(`x-demos-bind: demos-tlsn:v1:store:${SENDER}:${REQUEST.slice(2)}\r\n`)
        nextOutput = out

        expect(verifyStoredPresentation(input({ requestTxHash: REQUEST.slice(2) })).ok).toBe(true)
    })

    it("accepts the k256 vector too", () => {
        nextOutput = asStore(vector("valid-local-k256"))
        expect(verifyStoredPresentation(input()).ok).toBe(true)
    })

    it("refuses the vector as recorded: it is bound to an identity context, not a store", () => {
        nextOutput = vector("valid-local")
        const verdict = verifyStoredPresentation(input())
        expect(verdict).toEqual({ ok: false, reason: 'the presentation is bound to "github", not to a store' })
    })

    it("refuses a notary key the fork does not list", () => {
        nextOutput = asStore(vector("wrong-notary-key"))
        const verdict = verifyStoredPresentation(input())
        expect(verdict.ok === false && verdict.reason).toContain("notary key")
    })

    it("refuses a presentation that names no server", () => {
        nextOutput = asStore(vector("no-server-identity"))
        const verdict = verifyStoredPresentation(input())
        expect(verdict.ok === false && verdict.reason).toContain("server")
    })

    it("refuses another sender and another request", () => {
        nextOutput = asStore(vector("valid-local"))
        expect(verifyStoredPresentation(input({ sender: "0x" + "33".repeat(32) })).ok).toBe(false)
        expect(verifyStoredPresentation(input({ requestTxHash: "44".repeat(32) })).ok).toBe(false)
    })

    it("matches the request hash with or without its 0x prefix", () => {
        nextOutput = asStore(vector("valid-local"))
        expect(verifyStoredPresentation(input({ requestTxHash: "22".repeat(32) })).ok).toBe(true)
    })

    it("judges freshness against the block time", () => {
        nextOutput = asStore(vector("valid-local"))
        const t = vector("valid-local").time
        expect(verifyStoredPresentation(input({ blockTimeSec: t + 3600 })).ok).toBe(true)
        expect(verifyStoredPresentation(input({ blockTimeSec: t + 3601 })).ok).toBe(false)
        expect(verifyStoredPresentation(input({ blockTimeSec: t - 60 })).ok).toBe(true)
        expect(verifyStoredPresentation(input({ blockTimeSec: t - 61 })).ok).toBe(false)
    })

    it("refuses a presentation that does not verify", () => {
        expect(verifyStoredPresentation(input())).toEqual({ ok: false, reason: "the presentation does not verify" })
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
                nextOutput = asStore(vector("valid-local"))
                expect(verifyStoredPresentation(input({ proof })).ok).toBe(false)
                expect(calls).toBe(0)
            })
        }

        it("accepts a proof at exactly the cap", () => {
            nextOutput = asStore(vector("valid-local"))
            expect(verifyStoredPresentation(input({ proof: proofOf(4096) })).ok).toBe(true)
        })
    })

    it("gives no verdict when the chain pins another verifier build", () => {
        getSharedState.forkConfig.tlsnVerified.verifierWasmSha256 = "01".repeat(32)
        expect(() => verifyStoredPresentation(input())).toThrow(FakeVerifierError)
    })

    it("gives no verdict when the fork is not active at the tip", () => {
        getSharedState.forkConfig.tlsnVerified.activationHeight = null
        expect(() => verifyStoredPresentation(input())).toThrow()
    })
})
