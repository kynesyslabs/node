/**
 * What a verified TLSNotary presentation must show to link a web2 identity
 * under the `tlsnVerified` fork. Pure: every input is the verifier's output
 * plus the transaction, so the verdict is the same on every node.
 */
import type { AcceptedPresentation } from "./presentationGate"
import {
    parseAuthedRequest,
    parseAuthedResponse,
    parseAuthedResponseHead,
    singleHeader,
    type HeaderLine,
} from "./httpTranscript"

/** The endpoint a context's identity is read from. */
export interface TlsnIdentityEndpoint {
    server: string
    method: string
    path: string
    /** The account in the endpoint's JSON response, or null when absent. */
    extract(body: Record<string, unknown>): { username: string; userId: string } | null
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256

/**
 * Contexts a TLSN proof can link under the fork. Telegram is not one: its
 * endpoint is a Demos backend, not Telegram, and Telegram links through its
 * own bot-signed attestation.
 */
export const TLSN_IDENTITY_ENDPOINTS: Readonly<Record<string, TlsnIdentityEndpoint>> = Object.freeze({
    github: {
        server: "api.github.com",
        method: "GET",
        path: "/user",
        extract: body =>
            nonEmpty(body.login) &&
            typeof body.id === "number" &&
            Number.isSafeInteger(body.id) &&
            body.id >= 0
                ? { username: body.login, userId: String(body.id) }
                : null,
    },
    discord: {
        server: "discord.com",
        method: "GET",
        path: "/api/users/@me",
        extract: body =>
            nonEmpty(body.username) &&
            typeof body.id === "string" &&
            /^(0|[1-9][0-9]{0,31})$/.test(body.id)
                ? { username: body.username, userId: body.id }
                : null,
    },
})

let activeEndpoints: Readonly<Record<string, TlsnIdentityEndpoint>> = TLSN_IDENTITY_ENDPOINTS

/**
 * Replaces the endpoint table, for tests whose vectors come from a local
 * test server; null restores the real one.
 */
export function setTlsnIdentityEndpointsForTests(
    endpoints: Readonly<Record<string, TlsnIdentityEndpoint>> | null,
): void {
    activeEndpoints = endpoints ?? TLSN_IDENTITY_ENDPOINTS
}

/** The endpoint of a context, read as an own key only. */
export function tlsnIdentityEndpoint(
    context: unknown,
    endpoints: Readonly<Record<string, TlsnIdentityEndpoint>> = activeEndpoints,
): TlsnIdentityEndpoint | null {
    return typeof context === "string" && Object.hasOwn(endpoints, context) ? endpoints[context] : null
}

export const BIND_HEADER = "x-demos-bind"
// The SDK form (sdks#194): the hash as the chain names transactions, with
// no 0x. A prefixed hash is refused, so one request has one bind value.
const BIND = /^demos-tlsn:v1:([a-z0-9_-]{1,32}):(0x[0-9a-f]{64}):([0-9a-f]{64})$/

/** Request headers whose values are credentials; a presentation must hide them. */
const SECRET_REQUEST_HEADERS: ReadonlySet<string> = new Set(["authorization", "proxy-authorization", "cookie"])

/** Response headers whose values are credentials, in every response block. */
const SECRET_RESPONSE_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"])

export interface BindClaim {
    /** "github", "discord" or "store". */
    purpose: string
    /** 0x + 64 lowercase hex. */
    sender: string
    /** The tlsn_request transaction hash, 64 lowercase hex, no prefix. */
    requestTxHash: string
}

/** Parses `demos-tlsn:v1:<purpose>:<sender 0x…>:<request tx hash, no 0x>`. */
export function parseBindValue(value: string): BindClaim | null {
    const m = BIND.exec(value)
    return m ? { purpose: m[1], sender: m[2], requestTxHash: m[3] } : null
}

/** An ed25519 account as the bind header names it: 0x + lowercase hex. */
export function bindSenderForm(account: string): string {
    const hex = account.toLowerCase()
    return hex.startsWith("0x") ? hex : `0x${hex}`
}

export interface TlsnIdentityFacts {
    username: string
    userId: string
    attestationId: string
    serverName: string
    bind: BindClaim
}

export type IdentityVerdict = { ok: true; facts: TlsnIdentityFacts } | { ok: false; reason: string }

const refuse = (reason: string): IdentityVerdict => ({ ok: false, reason })

function revealedSecret(headers: HeaderLine[], secret: ReadonlySet<string>): string | null {
    const leak = headers.find(h => secret.has(h.name) && h.valueRevealed)
    return leak ? leak.name : null
}

/**
 * Judges the transcript of an accepted presentation for an identity link of
 * `context` by `sender`. The request tx named by the bind header is checked
 * by the caller, which reads the chain.
 */
export function judgeIdentityTranscript(
    p: AcceptedPresentation,
    context: string,
    sender: string,
    endpoints: Readonly<Record<string, TlsnIdentityEndpoint>> = activeEndpoints,
): IdentityVerdict {
    const endpoint = tlsnIdentityEndpoint(context, endpoints)
    if (!endpoint) return refuse(`TLSN context ${context} cannot be linked with a TLSNotary proof`)

    if (p.serverName.toLowerCase() !== endpoint.server) {
        return refuse(`presentation is from ${p.serverName}, ${context} links come from ${endpoint.server}`)
    }

    const request = parseAuthedRequest({ bytes: p.sent, authed: p.sentAuthed })
    if (request.ok === false) return refuse(`request: ${request.reason}`)
    const req = request.value
    // Before anything else is read: a presentation that reveals a credential
    // is refused whatever else it proves, so none is ever stored on chain.
    const leak = revealedSecret(req.headers, SECRET_REQUEST_HEADERS)
    if (leak) return refuse(`presentation reveals the ${leak} header value`)
    if (req.method !== endpoint.method || req.target !== endpoint.path) {
        return refuse(`request is ${req.method} ${req.target}, ${context} links need ${endpoint.method} ${endpoint.path}`)
    }
    const host = singleHeader(req.headers, "host")
    if (host.ok === false) return refuse(`request: ${host.reason}`)
    if (host.value.value === null || host.value.value.toLowerCase() !== endpoint.server) {
        return refuse(`request Host is not ${endpoint.server}`)
    }

    const bindHeader = singleHeader(req.headers, BIND_HEADER)
    if (bindHeader.ok === false) return refuse(`request: ${bindHeader.reason}`)
    if (bindHeader.value.value === null) return refuse("X-Demos-Bind header is not fully revealed")
    const bind = parseBindValue(bindHeader.value.value)
    if (!bind) return refuse("X-Demos-Bind header is malformed")
    if (bind.purpose !== context) {
        return refuse(`X-Demos-Bind names ${bind.purpose}, the link is for ${context}`)
    }
    if (bind.sender !== bindSenderForm(sender)) {
        return refuse("X-Demos-Bind names another account than the transaction sender")
    }

    const response = parseAuthedResponse({ bytes: p.recv, authed: p.recvAuthed })
    if (response.ok === false) return refuse(`response: ${response.reason}`)
    for (const block of [...response.value.interim, response.value.headers]) {
        const cookie = revealedSecret(block, SECRET_RESPONSE_HEADERS)
        if (cookie) return refuse(`presentation reveals the ${cookie} response header value`)
    }
    if (response.value.status !== 200) return refuse(`response status is ${response.value.status}`)
    let json: unknown
    try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.value.body))
    } catch {
        return refuse("response body is not JSON")
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
        return refuse("response body is not a JSON object")
    }
    const user = endpoint.extract(json as Record<string, unknown>)
    if (!user) return refuse(`response has no ${context} account`)

    return {
        ok: true,
        facts: {
            username: user.username,
            userId: user.userId,
            attestationId: p.attestationId,
            serverName: p.serverName,
            bind,
        },
    }
}

/** The bind purpose of a `tlsn_store`. */
export const STORE_BIND_PURPOSE = "store"

export type StoreTranscriptVerdict = { ok: true; bind: BindClaim } | { ok: false; reason: string }

/**
 * Judges the transcript of an accepted presentation a `tlsn_store` puts on
 * chain for `sender` under the request `requestTxHash`. A store proves any
 * response, so only the request and the response heads are read: the
 * response body may be revealed in part, and the request may carry one
 * Content-Length body (a POST to an API), revealed or not. Credentials are refused in both directions,
 * since a stored proof is public for good.
 */
export function judgeStoreTranscript(
    p: AcceptedPresentation,
    sender: string,
    requestTxHash: string,
): StoreTranscriptVerdict {
    const request = parseAuthedRequest({ bytes: p.sent, authed: p.sentAuthed }, { allowBody: true })
    if (request.ok === false) return { ok: false, reason: `request: ${request.reason}` }
    const leak = revealedSecret(request.value.headers, SECRET_REQUEST_HEADERS)
    if (leak) return { ok: false, reason: `presentation reveals the ${leak} header value` }

    const response = parseAuthedResponseHead({ bytes: p.recv, authed: p.recvAuthed }, request.value.method)
    if (response.ok === false) return { ok: false, reason: `response: ${response.reason}` }
    for (const block of [...response.value.interim, response.value.headers]) {
        const cookie = revealedSecret(block, SECRET_RESPONSE_HEADERS)
        if (cookie) return { ok: false, reason: `presentation reveals the ${cookie} response header value` }
    }

    const host = singleHeader(request.value.headers, "host")
    if (host.ok === false) return { ok: false, reason: `request: ${host.reason}` }
    if (host.value.value === null || host.value.value.toLowerCase() !== p.serverName.toLowerCase()) {
        return { ok: false, reason: `request Host is not ${p.serverName}` }
    }

    const bindHeader = singleHeader(request.value.headers, BIND_HEADER)
    if (bindHeader.ok === false) return { ok: false, reason: `request: ${bindHeader.reason}` }
    if (bindHeader.value.value === null) return { ok: false, reason: "X-Demos-Bind header is not fully revealed" }
    const bind = parseBindValue(bindHeader.value.value)
    if (!bind) return { ok: false, reason: "X-Demos-Bind header is malformed" }
    if (bind.purpose !== STORE_BIND_PURPOSE) {
        return { ok: false, reason: `X-Demos-Bind names ${bind.purpose}, not a store` }
    }
    if (bind.sender !== bindSenderForm(sender)) {
        return { ok: false, reason: "X-Demos-Bind names another account than the transaction sender" }
    }
    if (bind.requestTxHash !== requestTxHash) {
        return { ok: false, reason: "X-Demos-Bind names another tlsn_request than the store" }
    }
    return { ok: true, bind }
}
