/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { isTrustedNotaryKey, tlsnVerifiedParams } from "@/forks/tlsnVerifiedGate"
import {
    TLSN_MAX_PRESENTATION_BYTES,
    TLSN_VERIFY_WASM_SHA256,
    TlsnVerifierUnavailableError,
    type TlsnVerifiedPresentation,
    verifyPresentation,
} from "./wasmVerifier"

/**
 * The checks a `tlsn_store` presentation must pass under `tlsnVerified`
 * before its proof row can be written. Every input is either signed by the
 * sender or fixed by the block, so the verdict is the same on every node.
 * The token checks (owner, expiry, domain, single use) need the chain's rows
 * and are made where the row is written.
 */

/** Room for the JSON envelope around the hex presentation (`version`, `meta`). */
export const STORED_PROOF_ENVELOPE_CHARS = 4096

export interface StoredPresentationInput {
    /** The `proof` arg of the store: JSON of a tlsn-js presentation `{version, data, meta}`. */
    proof: string
    /** Sender of the store, as the bind header must name it. */
    sender: string
    /** The `tlsn_request` tx hash the store names, as the bind header must name it. */
    requestTxHash: string
    /** Tip the fork payload (keys, caps) is read at. */
    tip: number
    /** Block time, unix seconds, that freshness is judged against. */
    blockTimeSec: number
}

export interface StoredPresentationFacts {
    attestationId: string
    /** Lowercase; the token's domain must equal it. */
    serverName: string
    /** Notary-attested connection time, unix seconds. */
    attestedTimeSec: number
    /** What the chain stores: `{version, data}` with lowercase hex, without the unsigned `meta`. */
    canonicalProof: string
}

export type StoredPresentationVerdict =
    | ({ ok: true } & StoredPresentationFacts)
    | { ok: false; reason: string }

const refuse = (reason: string): StoredPresentationVerdict => ({ ok: false, reason })

const HEX = /^(?:[0-9a-fA-F]{2})*$/

/** The bind header value prefix of a store: `demos-tlsn:v1:store:<sender>:<request hash>`. */
export const STORE_BIND_CONTEXT = "store"
const BIND_HEADER = "x-demos-bind"
// Revealing one of these would publish the prover's credentials with the proof.
const SECRET_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "proxy-authorization"])

export interface BindHeader {
    context: string
    sender: string
    requestTxHash: string
}

const bare = (hex: string) => hex.toLowerCase().replace(/^0x/, "")

function authed(ranges: [number, number][], start: number, end: number): boolean {
    // Ranges are disjoint and sorted by the verifier, but a cover may span
    // several adjacent ones, so walk them rather than look for one container.
    let at = start
    for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
        if (from > at) break
        if (to > at) at = to
        if (at >= end) return true
    }
    return at >= end
}

function anyAuthed(ranges: [number, number][], start: number, end: number): boolean {
    return ranges.some(([from, to]) => from < end && to > start)
}

interface HeaderLine {
    name: string
    value: string
    start: number
    valueStart: number
    end: number
}

/** Header lines of the request head in `sent`, with their byte offsets. */
function headerLines(sent: Buffer): HeaderLine[] {
    const headEnd = sent.indexOf("\r\n\r\n")
    const head = headEnd === -1 ? sent.length : headEnd
    const lines: HeaderLine[] = []
    // The first line is the request line, not a header.
    let start = sent.indexOf("\r\n")
    if (start === -1 || start >= head) return lines
    start += 2
    while (start < head) {
        let end = sent.indexOf("\r\n", start)
        if (end === -1 || end > head) end = head
        const colon = sent.indexOf(":", start)
        if (colon !== -1 && colon < end) {
            const name = sent.subarray(start, colon).toString("latin1").trim().toLowerCase()
            let valueStart = colon + 1
            while (valueStart < end && (sent[valueStart] === 0x20 || sent[valueStart] === 0x09)) valueStart++
            lines.push({
                name,
                value: sent.subarray(valueStart, end).toString("latin1").trim(),
                start,
                valueStart,
                end,
            })
        }
        start = end + 2
    }
    return lines
}

/**
 * The bind header of a verified presentation, or why there is none usable.
 * Bytes outside the authenticated ranges are zero in the verifier output, so
 * a redacted header cannot read as one; a header is used only when its whole
 * line is authenticated, and there must be exactly one.
 */
export function readBindHeader(
    verified: Pick<TlsnVerifiedPresentation, "sent" | "sentAuthed">,
): { ok: true; bind: BindHeader } | { ok: false; reason: string } {
    if (verified.sent === null || verified.sentAuthed === null) {
        return { ok: false, reason: "the sent transcript is not revealed" }
    }
    const sent = Buffer.from(verified.sent, "hex")
    const binds = headerLines(sent).filter(line => line.name === BIND_HEADER)
    if (binds.length !== 1) {
        return { ok: false, reason: `expected one ${BIND_HEADER} header, found ${binds.length}` }
    }
    const [line] = binds
    if (!authed(verified.sentAuthed, line.start, line.end)) {
        return { ok: false, reason: `the ${BIND_HEADER} header is not fully authenticated` }
    }
    const parts = line.value.split(":")
    if (parts.length !== 5 || parts[0] !== "demos-tlsn" || parts[1] !== "v1") {
        return { ok: false, reason: `malformed ${BIND_HEADER} header` }
    }
    return { ok: true, bind: { context: parts[2], sender: parts[3], requestTxHash: parts[4] } }
}

/** The name of a secret header whose value the presentation reveals, or null. */
export function revealedSecretHeader(
    verified: Pick<TlsnVerifiedPresentation, "sent" | "sentAuthed">,
): string | null {
    if (verified.sent === null || verified.sentAuthed === null) return null
    const sent = Buffer.from(verified.sent, "hex")
    for (const line of headerLines(sent)) {
        if (!SECRET_HEADERS.has(line.name)) continue
        if (line.end > line.valueStart && anyAuthed(verified.sentAuthed, line.valueStart, line.end)) {
            return line.name
        }
    }
    return null
}

/** The presentation bytes and canonical proof of a store's `proof` arg, or why it is refused. */
function decodeProof(
    proof: string,
    maxBytes: number,
): { ok: true; bytes: Uint8Array; canonical: string } | { ok: false; reason: string } {
    // Checked before parsing, so a huge arg costs no parse.
    if (proof.length > maxBytes * 2 + STORED_PROOF_ENVELOPE_CHARS) {
        return { ok: false, reason: `proof is larger than the ${maxBytes}-byte presentation cap` }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(proof)
    } catch {
        return { ok: false, reason: "proof is not JSON" }
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "proof is not a presentation object" }
    }
    const { version, data } = parsed as { version?: unknown; data?: unknown }
    if (typeof version !== "string" || version.length === 0 || version.length > 64) {
        return { ok: false, reason: "proof has no version" }
    }
    if (typeof data !== "string" || data.length === 0 || !HEX.test(data)) {
        return { ok: false, reason: "proof data is not hex" }
    }
    const length = data.length / 2
    if (length > maxBytes || length > TLSN_MAX_PRESENTATION_BYTES) {
        return { ok: false, reason: `presentation of ${length} bytes is over the ${maxBytes}-byte cap` }
    }
    const hex = data.toLowerCase()
    return {
        ok: true,
        bytes: new Uint8Array(Buffer.from(hex, "hex")),
        canonical: JSON.stringify({ version, data: hex }),
    }
}

/**
 * Verifies the presentation of a `tlsn_store` under `tlsnVerified`: size
 * caps, the pinned wasm verifier, a notary key the fork lists at `tip`, a
 * named server, an attested time within the freshness window of the block,
 * no revealed credentials, and a bind header that names this sender and the
 * request the store claims.
 *
 * A refusal is a verdict. A throw is none: the verifier could not load or
 * run on this node (TlsnVerifierLoadError, TlsnVerifierUnavailableError), or
 * the fork is not active at `tip`, and the caller must not judge the
 * transaction on it.
 */
export function verifyStoredPresentation(input: StoredPresentationInput): StoredPresentationVerdict {
    const params = tlsnVerifiedParams(input.tip)
    if (!params) throw new Error(`[TLSNotary] tlsnVerified is not active at ${input.tip}`)
    if (params.verifierWasmSha256 !== TLSN_VERIFY_WASM_SHA256) {
        // Another verifier build would give the network's verdict, not this one.
        throw new TlsnVerifierUnavailableError(
            `this node carries verifier ${TLSN_VERIFY_WASM_SHA256}, the chain verifies with ${params.verifierWasmSha256}`,
        )
    }

    const decoded = decodeProof(input.proof, params.maxPresentationBytes)
    if (decoded.ok === false) return refuse(decoded.reason)

    const result = verifyPresentation(decoded.bytes)
    if (result.ok === false) return refuse("the presentation does not verify")
    const out = result.out

    if (!out.attestationVersionIsCurrent) return refuse("the attestation version is not the pinned one")
    if (!isTrustedNotaryKey(input.tip, out.verifyingKey.alg, out.verifyingKey.hex)) {
        return refuse("the presentation is signed by a notary key the chain does not list")
    }
    if (out.serverName === null || out.serverName.length === 0) {
        return refuse("the presentation does not name its server")
    }
    if (!Number.isSafeInteger(out.time)) return refuse("the attested time is not a number")
    if (out.time < input.blockTimeSec - params.freshnessWindowSec) {
        return refuse("the attested connection is older than the freshness window")
    }
    if (out.time > input.blockTimeSec + params.futureSkewSec) {
        return refuse("the attested connection is later than the block time")
    }

    const secret = revealedSecretHeader(out)
    if (secret) return refuse(`the presentation reveals the ${secret} header`)

    const bind = readBindHeader(out)
    if (bind.ok === false) return refuse(bind.reason)
    if (bind.bind.context !== STORE_BIND_CONTEXT) {
        return refuse(`the presentation is bound to "${bind.bind.context}", not to a store`)
    }
    if (bare(bind.bind.sender) !== bare(input.sender)) {
        return refuse("the presentation is bound to another sender")
    }
    if (bare(bind.bind.requestTxHash) !== bare(input.requestTxHash)) {
        return refuse("the presentation is bound to another request")
    }

    return {
        ok: true,
        attestationId: out.attestationId,
        serverName: out.serverName.toLowerCase(),
        attestedTimeSec: out.time,
        canonicalProof: decoded.canonical,
    }
}
