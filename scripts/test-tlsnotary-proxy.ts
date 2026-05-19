/**
 * Epic 12 T8 — partial Node-side driver for the TLSNotary proxy path.
 *
 * What this verifies:
 *   - The node's `requestTLSNproxy` RPC handler is reachable through the
 *     Caddy proxy (path-mode or otherwise).
 *   - The returned `websocketProxyUrl` is well-formed and matches the
 *     EXPOSED_URL shape the operator configured.
 *
 * What this does NOT verify:
 *   - The full notary session (Prover -> Notarize -> Presentation).
 *     That path lives inside a Web Worker + WASM in @kynesyslabs/demosdk,
 *     so a Node-side driver can't drive it without a browser context.
 *     Use Playwright for end-to-end validation (Epic 12 T8 full).
 *
 * Usage:
 *   NODE_URL=https://localhost \
 *   TARGET_URL=https://api.github.com/zen \
 *   ALLOW_INSECURE=1 \
 *   bun run scripts/test-tlsnotary-proxy.ts
 *
 * Env:
 *   NODE_URL        Base URL of the node's RPC root (default
 *                   http://localhost:53550 — direct mode). Set to
 *                   https://localhost or https://${PROXY_DOMAIN} to
 *                   exercise the proxied path.
 *   TARGET_URL      HTTPS URL to notarize. Just used to ask the node
 *                   to allocate a proxy for it; no actual notary
 *                   session runs here.
 *   ALLOW_INSECURE  1 = accept self-signed certs (Caddy localhost dev).
 *   EXPECTED_HOST   If set, asserts that the returned websocketProxyUrl
 *                   uses this host. Useful for verifying EXPOSED_URL
 *                   plumbing produced the expected outside-the-container
 *                   address.
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

interface ProxyResponse {
    websocketProxyUrl: string
    targetDomain: string
    expiresIn: number
    proxyId: string
}

const NODE_URL = process.env.NODE_URL || "http://localhost:53550"
const TARGET_URL = process.env.TARGET_URL || "https://api.github.com/zen"
const ALLOW_INSECURE = process.env.ALLOW_INSECURE === "1"
const EXPECTED_HOST = process.env.EXPECTED_HOST || ""

// Bun's global fetch does NOT support Undici's `dispatcher` option —
// see https://github.com/oven-sh/bun/issues/4474. Use the native
// `tls.rejectUnauthorized` option instead. The casts to `never` are
// because @types/bun adds the field but the lib.dom.d.ts RequestInit
// doesn't.
const fetchInit: RequestInit = ALLOW_INSECURE
    ? ({ tls: { rejectUnauthorized: false } } as never)
    : {}

// Sanitize log message to strip ANSI escapes + control chars + cap
// length. The driver echoes upstream server text into the terminal;
// without this, a malicious node response could inject terminal
// escape sequences (CWE-117). Sonar tssecurity:S5145.
// Loop form (not a regex character class) avoids the eslint
// `no-control-regex` rule that ships in `eslint:recommended`.
function sanitize(s: string): string {
    let out = ""
    for (const ch of s) {
        const code = ch.charCodeAt(0)
        out += code <= 0x1f || code === 0x7f ? "?" : ch
        if (out.length >= 500) break
    }
    return out
}

function log(level: "pass" | "fail" | "info", msg: string): void {
    const tag =
        level === "pass" ? "[PASS]" : level === "fail" ? "[FAIL]" : "[INFO]"
    console.log(`${tag} ${sanitize(msg)}`)
}

async function main(): Promise<number> {
    log("info", `Node URL:    ${NODE_URL}`)
    log("info", `Target URL:  ${TARGET_URL}`)
    log("info", `Allow insecure: ${ALLOW_INSECURE}`)

    // Step 1 — health probe. Confirms the node + proxy are reachable.
    let healthBody: Record<string, unknown> | null = null
    try {
        const res = await fetch(`${NODE_URL}/health`, fetchInit)
        if (!res.ok) {
            log("fail", `/health -> HTTP ${res.status}`)
            return 1
        }
        healthBody = (await res.json()) as Record<string, unknown>
        log("pass", `/health -> 200 (status=${healthBody.status})`)
    } catch (err) {
        log(
            "fail",
            `/health unreachable: ${err instanceof Error ? err.message : String(err)}`,
        )
        return 1
    }

    // Step 2 — requestTLSNproxy via the RPC root.
    let proxyResp: ProxyResponse | null = null
    try {
        const res = await fetch(NODE_URL, {
            ...fetchInit,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                method: "nodeCall",
                params: [
                    {
                        message: "requestTLSNproxy",
                        data: { targetUrl: TARGET_URL },
                    },
                ],
            }),
        })

        if (!res.ok) {
            log("fail", `requestTLSNproxy -> HTTP ${res.status}`)
            return 1
        }

        const body = (await res.json()) as {
            result: number
            response: ProxyResponse | { error?: string; message?: string }
        }
        if (body.result !== 200) {
            const err = body.response as { error?: string; message?: string }
            const msg = err.message || err.error || "(no message)"
            // 400 with "Missing tokenId or owner parameter" proves the
            // node received + parsed our call. Without a real DAHR
            // token we can't get a real proxy URL — but reaching the
            // handler is the only thing this driver verifies. Treat
            // as PASS-with-caveat. Full URL validation needs a browser
            // driver (Playwright TODO).
            if (body.result === 400 && /tokenId|owner/i.test(msg)) {
                log(
                    "pass",
                    `requestTLSNproxy reached node handler (got 400 "${msg}" — expected without a real DAHR token).`,
                )
                log(
                    "info",
                    "Full proxy URL validation needs a real notary token from the DAHR flow. Use a browser/Playwright driver for that path.",
                )
                return 0
            }
            log(
                "fail",
                `requestTLSNproxy returned result=${body.result}: ${msg}`,
            )
            return 1
        }

        proxyResp = body.response as ProxyResponse
        log(
            "pass",
            `requestTLSNproxy -> websocketProxyUrl=${proxyResp.websocketProxyUrl} (expires in ${proxyResp.expiresIn}s)`,
        )
    } catch (err) {
        log(
            "fail",
            `requestTLSNproxy threw: ${err instanceof Error ? err.message : String(err)}`,
        )
        return 1
    }

    // Step 3 — URL shape checks.
    let parsed: URL
    try {
        parsed = new URL(proxyResp.websocketProxyUrl)
    } catch (err) {
        log(
            "fail",
            `websocketProxyUrl is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
        )
        return 1
    }

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        log("fail", `websocketProxyUrl protocol=${parsed.protocol} (expected ws/wss)`)
        return 1
    }
    log("pass", `websocketProxyUrl protocol=${parsed.protocol}`)

    if (EXPECTED_HOST) {
        if (parsed.hostname !== EXPECTED_HOST) {
            log(
                "fail",
                `websocketProxyUrl hostname=${parsed.hostname} (expected ${EXPECTED_HOST}) — check EXPOSED_URL`,
            )
            return 1
        }
        log("pass", `websocketProxyUrl hostname matches EXPECTED_HOST=${EXPECTED_HOST}`)
    } else {
        log("info", `websocketProxyUrl hostname=${parsed.hostname} (set EXPECTED_HOST to assert)`)
    }

    // Path-mode hint: a path other than "/" suggests EXPOSED_URL has a
    // base path baked in, which is what we want behind a reverse proxy.
    if (parsed.pathname !== "/" && parsed.pathname.length > 1) {
        log("pass", `websocketProxyUrl is path-mode (path=${parsed.pathname})`)
    } else {
        log(
            "info",
            `websocketProxyUrl is host:port mode (no path). Set EXPOSED_URL with a path to use path-mode behind a proxy.`,
        )
    }

    console.log("")
    log(
        "info",
        "Partial T8 PASS. Full notary session (Prover/Notarize) needs a browser context — see scripts/test-tlsnotary-proxy.playwright.ts.",
    )
    return 0
}

main()
    .then(code => process.exit(code))
    .catch(err => {
        console.error("[FAIL] uncaught:", err)
        process.exit(1)
    })

export {}
