// Request handlers for the staking page: the page itself, the Solana read
// relay and the proof submission. Everything the handlers need from the node
// comes in through `deps`, so the decisions are testable without a server.
import { decodeProofTransaction } from "./proofBytes"
import {
    HourlyBudget,
    MAX_RELAY_BODY_BYTES,
    MAX_SUBMIT_BODY_BYTES,
    checkRelayRequest,
    injectPageConfig,
} from "./pageBudget"

export const STAKING_PAGE_PATH = "/staking"
export const STAKING_RELAY_PATH = "/staking/rpc"
export const STAKING_SUBMIT_PATH = "/staking/submit"

/** Upstream calls made for one relayed request before answering 502. */
export const RELAY_ATTEMPTS = 2

/** The anchor node did not answer, so no decision about seats can be made. */
export class AnchorUnreachableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "AnchorUnreachableError"
    }
}

export interface RecordedProof {
    accepted: boolean
    message: string
}

export interface ValidationDeps {
    pageHtml: () => string
    /** This node's Demos address, lowercase with 0x. */
    ownAddress: () => string
    /** The keyed Solana endpoint reads are relayed to, or null when none is configured. */
    solanaRpcUrl: () => string | null
    budget: HourlyBudget
    /** Whether this node holds a seat, asked of the anchor. Throws AnchorUnreachableError. */
    nodeHoldsSeat: () => Promise<boolean>
    /** The address whose seat `mint` backs now, asked of the anchor, or null. Throws AnchorUnreachableError. */
    mintHolder: (mint: string) => Promise<string | null>
    isAllowlistedMint: (mint: string) => boolean
    /** Sends the wallet-signed proof to Solana. */
    recordProof: (bytes: Uint8Array) => Promise<RecordedProof>
    fetch?: typeof fetch
    relayTimeoutMs?: number
}

export interface ValidationHandlers {
    page: (req: Request) => Promise<Response>
    relay: (req: Request) => Promise<Response>
    submit: (req: Request) => Promise<Response>
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    })
}

const notFound = () => json({ error: "Not Found" }, 404)

function declaredLength(req: Request): number | null {
    const raw = req.headers.get("content-length")
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
}

async function readBody(req: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
    const declared = declaredLength(req)
    if (declared !== null && declared > maxBytes) {
        return { ok: false, response: json({ error: `body over ${maxBytes} bytes` }, 413) }
    }
    const text = await req.text()
    if (Buffer.byteLength(text) > maxBytes) {
        return { ok: false, response: json({ error: `body over ${maxBytes} bytes` }, 413) }
    }
    return { ok: true, text }
}

export function createValidationHandlers(deps: ValidationDeps): ValidationHandlers {
    const fetchImpl = deps.fetch ?? fetch
    const relayTimeoutMs = deps.relayTimeoutMs ?? 10_000

    /** The page and its routes exist only while this node has no seat. */
    async function gate(): Promise<Response | null> {
        try {
            return (await deps.nodeHoldsSeat()) ? notFound() : null
        } catch (e) {
            if (e instanceof AnchorUnreachableError) {
                return json({ error: `anchor node unreachable: ${e.message}` }, 503)
            }
            throw e
        }
    }

    function spend(): Response | null {
        const taken = deps.budget.take()
        if (taken.ok === true) return null
        return json(
            { error: "this node's hourly Solana budget is spent", retryAfterSeconds: taken.retryAfterSeconds },
            429,
            { "Retry-After": String(taken.retryAfterSeconds) },
        )
    }

    return {
        async page() {
            const closed = await gate()
            if (closed) return closed
            const html = injectPageConfig(deps.pageHtml(), {
                demosAddress: deps.ownAddress(),
                rpcUrl: STAKING_RELAY_PATH,
                submitUrl: STAKING_SUBMIT_PATH,
            })
            return new Response(html, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
            })
        },

        async relay(req) {
            const closed = await gate()
            if (closed) return closed
            const upstream = deps.solanaRpcUrl()
            if (upstream === null) return json({ error: "no keyed Solana endpoint configured" }, 503)
            const body = await readBody(req, MAX_RELAY_BODY_BYTES)
            if (body.ok === false) return body.response
            let parsed: unknown
            try {
                parsed = JSON.parse(body.text)
            } catch {
                return json({ error: "body is not JSON" }, 400)
            }
            const check = checkRelayRequest(parsed)
            if (check.ok === false) return json({ error: check.reason }, 400)
            const spent = spend()
            if (spent) return spent
            // One budget unit buys two attempts: a stalled or dropped upstream
            // call is retried once before the page is told the endpoint failed.
            let lastError: unknown = null
            for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt++) {
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), relayTimeoutMs)
                try {
                    const res = await fetchImpl(upstream, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: body.text,
                        signal: controller.signal,
                    })
                    const text = await res.text()
                    return new Response(text, {
                        status: res.status,
                        headers: { "Content-Type": "application/json" },
                    })
                } catch (e) {
                    lastError = e
                } finally {
                    clearTimeout(timer)
                }
            }
            const reason = lastError instanceof Error ? lastError.message : String(lastError)
            return json({ error: `Solana endpoint did not answer after ${RELAY_ATTEMPTS} attempts: ${reason}` }, 502)
        },

        async submit(req) {
            const closed = await gate()
            if (closed) return closed
            const body = await readBody(req, MAX_SUBMIT_BODY_BYTES)
            if (body.ok === false) return body.response
            let transaction: unknown
            try {
                transaction = (JSON.parse(body.text) as { transaction?: unknown })?.transaction
            } catch {
                return json({ error: "body is not JSON" }, 400)
            }
            if (typeof transaction !== "string" || !/^[A-Za-z0-9+/=]+$/.test(transaction)) {
                return json({ error: "transaction must be the signed proof as base64" }, 400)
            }
            const bytes = Uint8Array.from(Buffer.from(transaction, "base64"))
            const decoded = decodeProofTransaction(bytes)
            if (decoded.ok === false) return json({ error: decoded.reason }, 400)
            const { proof } = decoded
            const own = deps.ownAddress()
            if (proof.demosAddress !== own) {
                return json({ error: `proof memo names ${proof.demosAddress}, not this node's address ${own}` }, 400)
            }
            if (!deps.isAllowlistedMint(proof.mint)) {
                return json({ error: `mint ${proof.mint} is not an eligible node NFT` }, 400)
            }
            let holder: string | null
            try {
                holder = await deps.mintHolder(proof.mint)
            } catch (e) {
                if (e instanceof AnchorUnreachableError) {
                    return json({ error: `anchor node unreachable: ${e.message}` }, 503)
                }
                throw e
            }
            const spent = spend()
            if (spent) return spent
            const recorded = await deps.recordProof(bytes)
            if (!recorded.accepted) {
                return json({ error: recorded.message }, 502)
            }
            return json({
                solanaSignature: proof.signature,
                owner: proof.owner,
                mint: proof.mint,
                /** The validator whose seat this mint backs now; staking evicts it. */
                evicts: holder,
                message: recorded.message,
            })
        },
    }
}
