/**
 * HTTP/1.1 parsing over a TLSNotary transcript, reading authenticated bytes
 * only. The verifier zeroes every byte outside the authed ranges, but a zero
 * stands for an unknown byte of the real transcript, not for a zero; so no
 * structure (line ends, names, framing, body) may be taken from such a byte.
 *
 * Pure and deterministic: a verdict here is part of the consensus verdict on
 * an identity link. Refusal texts are for logs only.
 */

type Ranges = readonly (readonly [number, number])[]

export interface AuthedBytes {
    bytes: Uint8Array
    authed: Ranges
}

export interface HeaderLine {
    /** Lowercased header name. */
    name: string
    /** The value, when every byte of it is authenticated; else null. */
    value: string | null
    /** Whether the value is revealed (a value is revealed whole or not at all). */
    valueRevealed: boolean
}

export interface ParsedRequest {
    method: string
    target: string
    version: string
    headers: HeaderLine[]
}

export interface ParsedResponse {
    status: number
    /** Headers of the interim 1xx responses before the final one, in order. */
    interim: HeaderLine[][]
    headers: HeaderLine[]
    /** The decoded body (framing removed), every byte authenticated. */
    body: Uint8Array
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

const fail = <T>(reason: string): Parsed<T> => ({ ok: false, reason })

const CR = 0x0d
const LF = 0x0a
const COLON = 0x3a
const SP = 0x20
const HTAB = 0x09

/** At most this many header lines; real API responses carry about thirty. */
const MAX_HEADER_LINES = 128

/** At most this many interim 1xx responses before the final one. */
const MAX_INTERIM_RESPONSES = 8

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function maskOf({ bytes, authed }: AuthedBytes): Uint8Array {
    const mask = new Uint8Array(bytes.length)
    for (const [start, end] of authed) mask.fill(1, start, end)
    return mask
}

const allAuthed = (mask: Uint8Array, start: number, end: number): boolean => {
    for (let i = start; i < end; i++) if (!mask[i]) return false
    return true
}

const anyAuthed = (mask: Uint8Array, start: number, end: number): boolean => {
    for (let i = start; i < end; i++) if (mask[i]) return true
    return false
}

/** Index of the first authenticated CRLF CRLF at or after `from`, else -1. */
function headEnd(bytes: Uint8Array, mask: Uint8Array, from = 0): number {
    for (let i = from; i + 3 < bytes.length; i++) {
        if (
            bytes[i] === CR &&
            bytes[i + 1] === LF &&
            bytes[i + 2] === CR &&
            bytes[i + 3] === LF &&
            allAuthed(mask, i, i + 4)
        ) {
            return i
        }
    }
    return -1
}

/** [start, end) of each line of [from, to), split at authenticated CRLFs. */
function linesOf(bytes: Uint8Array, mask: Uint8Array, from: number, to: number): [number, number][] {
    const lines: [number, number][] = []
    let start = from
    for (let i = from; i + 1 < to; i++) {
        if (bytes[i] === CR && bytes[i + 1] === LF && mask[i] && mask[i + 1]) {
            lines.push([start, i])
            start = i + 2
            i++
        }
    }
    lines.push([start, to])
    return lines
}

const latin1 = (bytes: Uint8Array, start: number, end: number): string =>
    Buffer.from(bytes.subarray(start, end)).toString("latin1")

/**
 * Header lines of [from, to). A line is either a header whose name and colon
 * are authenticated and whose value is revealed whole or not at all, or a
 * line with no authenticated byte (a hidden header). Anything else is
 * refused: whatever it reveals could be the value of a credential header.
 */
function headersOf(
    bytes: Uint8Array,
    mask: Uint8Array,
    from: number,
    to: number,
): Parsed<HeaderLine[]> {
    if (from >= to) return { ok: true, value: [] }
    const lines = linesOf(bytes, mask, from, to)
    if (lines.length > MAX_HEADER_LINES) return fail("too many header lines")
    const headers: HeaderLine[] = []
    for (const [start, end] of lines) {
        if (!anyAuthed(mask, start, end)) continue
        let colon = -1
        for (let i = start; i < end; i++) {
            if (!mask[i]) break
            if (bytes[i] === COLON) {
                colon = i
                break
            }
        }
        if (colon <= start) {
            return fail("a header line reveals bytes but hides its name")
        }
        const name = latin1(bytes, start, colon)
        if (!TOKEN.test(name)) return fail(`malformed header name ${JSON.stringify(name)}`)
        let v = colon + 1
        while (v < end && mask[v] && (bytes[v] === SP || bytes[v] === HTAB)) v++
        let vEnd = end
        while (vEnd > v && mask[vEnd - 1] && (bytes[vEnd - 1] === SP || bytes[vEnd - 1] === HTAB)) vEnd--
        const full = allAuthed(mask, v, vEnd)
        const revealed = anyAuthed(mask, v, vEnd)
        // A hidden span inside a value may hold a line end and the name of
        // another header, so bytes revealed after it could be a credential
        // read as part of this header.
        if (revealed && !full) return fail(`the ${name.toLowerCase()} header value is partly revealed`)
        headers.push({
            name: name.toLowerCase(),
            value: full ? latin1(bytes, v, vEnd) : null,
            valueRevealed: revealed,
        })
    }
    return { ok: true, value: headers }
}

/**
 * The single request the sent transcript holds: an authenticated request
 * line, its headers, and nothing after the blank line (an identity request
 * is a GET without a body, and a second request would be answered by a
 * second response the rules do not read).
 */
export function parseAuthedRequest(sent: AuthedBytes): Parsed<ParsedRequest> {
    const { bytes } = sent
    const mask = maskOf(sent)
    const end = headEnd(bytes, mask)
    if (end < 0) return fail("request has no authenticated end of headers")
    if (end + 4 !== bytes.length) {
        return fail("sent transcript holds more than one bodiless request")
    }
    const [first, ...rest] = linesOf(bytes, mask, 0, end)
    if (!allAuthed(mask, first[0], first[1])) {
        return fail("request line is not fully revealed")
    }
    const parts = latin1(bytes, first[0], first[1]).split(" ")
    if (parts.length !== 3 || !TOKEN.test(parts[0]) || parts[1].length === 0) {
        return fail("malformed request line")
    }
    const [method, target, version] = parts
    if (version !== "HTTP/1.1") return fail(`request is ${version}, not HTTP/1.1`)
    const headers = rest.length === 0 ? { ok: true as const, value: [] } : headersOf(bytes, mask, rest[0][0], end)
    if (headers.ok === false) return fail(headers.reason)
    return { ok: true, value: { method, target, version, headers: headers.value } }
}

/** The one header named `name`, or a refusal when it is missing or repeated. */
export function singleHeader(headers: HeaderLine[], name: string): Parsed<HeaderLine> {
    const found = headers.filter(h => h.name === name)
    if (found.length === 0) return fail(`no revealed ${name} header`)
    if (found.length > 1) return fail(`${name} header repeated`)
    return { ok: true, value: found[0] }
}

function decodeChunked(
    bytes: Uint8Array,
    mask: Uint8Array,
    from: number,
): Parsed<Uint8Array> {
    const parts: Uint8Array[] = []
    let total = 0
    let at = from
    for (;;) {
        let lineEnd = -1
        for (let i = at; i + 1 < bytes.length; i++) {
            if (bytes[i] === CR && bytes[i + 1] === LF) {
                lineEnd = i
                break
            }
        }
        if (lineEnd < 0 || !allAuthed(mask, at, lineEnd + 2)) {
            return fail("chunk size line is missing or not revealed")
        }
        // Chunk extensions are legal but no API the rules read sends them.
        const sizeText = latin1(bytes, at, lineEnd)
        if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) return fail("malformed chunk size")
        const size = parseInt(sizeText, 16)
        at = lineEnd + 2
        if (size === 0) {
            // No trailers: the terminating CRLF must end the transcript.
            if (at + 2 !== bytes.length || bytes[at] !== CR || bytes[at + 1] !== LF || !allAuthed(mask, at, at + 2)) {
                return fail("chunked body does not end the transcript")
            }
            break
        }
        if (at + size + 2 > bytes.length) return fail("chunk runs past the transcript")
        if (!allAuthed(mask, at, at + size + 2)) return fail("chunk is not fully revealed")
        if (bytes[at + size] !== CR || bytes[at + size + 1] !== LF) return fail("chunk is not CRLF-terminated")
        parts.push(bytes.subarray(at, at + size))
        total += size
        at += size + 2
    }
    const body = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
        body.set(p, o)
        o += p.length
    }
    return { ok: true, value: body }
}

interface ResponseHead {
    status: number
    headers: HeaderLine[]
    /** Index of the first byte after the blank line. */
    next: number
}

function responseHeadAt(bytes: Uint8Array, mask: Uint8Array, at: number): Parsed<ResponseHead> {
    const end = headEnd(bytes, mask, at)
    if (end < 0) return fail("response has no authenticated end of headers")
    const [first, ...rest] = linesOf(bytes, mask, at, end)
    if (!allAuthed(mask, first[0], first[1])) {
        return fail("status line is not fully revealed")
    }
    const status = /^HTTP\/1\.1 ([1-5][0-9]{2})(?: .*)?$/.exec(latin1(bytes, first[0], first[1]))
    if (!status) return fail("malformed status line")
    const headers = rest.length === 0 ? { ok: true as const, value: [] } : headersOf(bytes, mask, rest[0][0], end)
    if (headers.ok === false) return fail(headers.reason)
    return { ok: true, value: { status: Number(status[1]), headers: headers.value, next: end + 4 } }
}

/**
 * The response the received transcript holds: any interim 1xx responses
 * (103 Early Hints), then the final one. Each interim block is read as a
 * header block, so its successor's headers are never taken for body bytes.
 * The final body is framed by Content-Length, by chunked transfer coding,
 * or, with neither, by the end of the connection (the notary saw the close,
 * so the transcript ends where the body does). Every byte the body takes
 * must be authenticated, and the body must end the transcript.
 */
export function parseAuthedResponse(recv: AuthedBytes): Parsed<ParsedResponse> {
    const { bytes } = recv
    const mask = maskOf(recv)
    const interim: HeaderLine[][] = []
    let at = 0
    let final: ResponseHead
    for (;;) {
        const head = responseHeadAt(bytes, mask, at)
        if (head.ok === false) return fail(head.reason)
        if (head.value.status >= 200) {
            final = head.value
            break
        }
        // After a 101 the connection speaks another protocol: no final
        // HTTP response follows.
        if (head.value.status === 101) return fail("response switches protocols")
        if (interim.length === MAX_INTERIM_RESPONSES) return fail("too many interim responses")
        interim.push(head.value.headers)
        at = head.value.next
    }
    const { status, headers, next: bodyStart } = final

    const te = headers.filter(h => h.name === "transfer-encoding")
    const cl = headers.filter(h => h.name === "content-length")
    const ce = headers.filter(h => h.name === "content-encoding")
    if (te.length > 1 || cl.length > 1 || ce.length > 1) return fail("framing header repeated")
    if (te.length === 1 && cl.length === 1) return fail("both Content-Length and Transfer-Encoding")
    if (ce.length === 1 && (ce[0].value === null || ce[0].value.toLowerCase() !== "identity")) {
        return fail("response body is content-encoded")
    }

    let body: Uint8Array
    if (te.length === 1) {
        if (te[0].value === null || te[0].value.toLowerCase() !== "chunked") {
            return fail("unsupported Transfer-Encoding")
        }
        const decoded = decodeChunked(bytes, mask, bodyStart)
        if (decoded.ok === false) return fail(decoded.reason)
        body = decoded.value
    } else if (cl.length === 1) {
        if (cl[0].value === null || !/^(0|[1-9][0-9]{0,8})$/.test(cl[0].value)) {
            return fail("Content-Length is not revealed or not a length")
        }
        const length = Number(cl[0].value)
        if (bodyStart + length !== bytes.length) {
            return fail("Content-Length does not end the transcript")
        }
        if (!allAuthed(mask, bodyStart, bytes.length)) return fail("response body is not fully revealed")
        body = bytes.subarray(bodyStart)
    } else {
        if (!allAuthed(mask, bodyStart, bytes.length)) return fail("response body is not fully revealed")
        body = bytes.subarray(bodyStart)
    }
    return { ok: true, value: { status, interim, headers: headers, body } }
}
