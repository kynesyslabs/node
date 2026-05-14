import { Server } from "bun"
import { Headers } from "node-fetch"
import log from "@/utilities/logger"

export type BunRequest = Request & { params: Record<string, string> }
export type Handler = (req: BunRequest) => Promise<Response> | Response
export type Middleware = (
    req: Request,
    next: () => Promise<Response>,
    server?: Server,
) => Promise<Response>

export class BunServer {
    private routes: Map<string, Map<string, Handler>> = new Map()
    private middlewares: Middleware[] = []
    private port: number
    private hostname: string
    public server: Server | null = null

    constructor(port: number, hostname = "0.0.0.0") {
        this.port = port
        this.hostname = hostname
    }

    use(middleware: Middleware): BunServer {
        this.middlewares.push(middleware)
        return this
    }

    get(path: string, handler: Handler): BunServer {
        this.addRoute("GET", path, handler)
        return this
    }

    post(path: string, handler: Handler): BunServer {
        this.addRoute("POST", path, handler)
        return this
    }

    private addRoute(method: string, path: string, handler: Handler): void {
        if (!this.routes.has(method)) {
            this.routes.set(method, new Map())
        }
        this.routes.get(method)?.set(path, handler)
    }

    private matchRoute(
        method: string,
        path: string,
    ): { handler: Handler; params: Record<string, string> } | null {
        const methodRoutes = this.routes.get(method)
        if (!methodRoutes) {
            return null
        }

        const exact = methodRoutes.get(path)
        if (exact) {
            return { handler: exact, params: {} }
        }

        const requestedParts = path.split("/").filter(Boolean)
        for (const [routePath, handler] of methodRoutes.entries()) {
            const routeParts = routePath.split("/").filter(Boolean)
            if (routeParts.length !== requestedParts.length) {
                continue
            }

            const params: Record<string, string> = {}
            let matches = true

            for (let i = 0; i < routeParts.length; i++) {
                const routePart = routeParts[i]
                const requestedPart = requestedParts[i]

                if (routePart.startsWith(":")) {
                    params[routePart.slice(1)] = decodeURIComponent(requestedPart)
                    continue
                }

                if (routePart === "*") {
                    continue
                }

                if (routePart !== requestedPart) {
                    matches = false
                    break
                }
            }

            if (matches) {
                return { handler, params }
            }
        }

        return null
    }

    private async handleRequest(
        req: Request,
        server?: Server,
    ): Promise<Response> {
        const url = new URL(req.url)
        const method = req.method
        const path = url.pathname

        // Create the final handler (route handler)
        const finalHandler = async (): Promise<Response> => {
            const match = this.matchRoute(method, path)
            if (match) {
                const bunReq = req as BunRequest
                bunReq.params = match.params
                return await match.handler(bunReq)
            }

            return jsonResponse({ error: "Not Found" }, 404)
        }

        // Build middleware chain from right to left (last to first)
        let handler = finalHandler
        for (let i = this.middlewares.length - 1; i >= 0; i--) {
            const middleware = this.middlewares[i]
            const nextHandler = handler
            handler = async () => {
                return await middleware(req, nextHandler, server)
            }
        }

        // Execute the complete chain
        return await handler()
    }

    start(): Server {
        this.server = Bun.serve({
            port: this.port,
            hostname: this.hostname,
            fetch: async (req, server) => {
                return await this.handleRequest(req, server)
            },
        })
        return this.server
    }

    stop(): void {
        if (this.server) {
            this.server.stop()
            this.server = null
        }
    }
}

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------
//
// Default behaviour is `Access-Control-Allow-Origin: *` for back-compat.
// Set `CORS_ALLOWED_ORIGINS` (comma-separated list of origins) to lock it
// down — Epic 12 T12. When a wildcard is in effect AND the node is being
// fronted by Caddy, a startup warning is emitted (once) so operators
// notice. The allowlist comparison is case-insensitive and tolerates
// trailing slashes.
//
// Examples:
//   CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
//   CORS_ALLOWED_ORIGINS=*                  (explicit wildcard, no warning)
//   (unset)                                 (implicit wildcard, warning if proxy)

let corsWarningEmitted = false

function loadCorsAllowedOrigins(): string[] | "*" {
    const raw = process.env.CORS_ALLOWED_ORIGINS
    if (!raw || raw.trim() === "" || raw.trim() === "*") {
        return "*"
    }
    return raw
        .split(",")
        .map(s => s.trim().replace(/\/$/, "").toLowerCase())
        .filter(s => s.length > 0)
}

function maybeWarnCorsWildcard(allowed: string[] | "*"): void {
    if (corsWarningEmitted) return
    if (allowed !== "*") return
    const behindProxy =
        !!process.env.PROXY_DOMAIN &&
        process.env.PROXY_DOMAIN !== "localhost"
    if (!behindProxy) return
    corsWarningEmitted = true
    // Lazy require to avoid circular import at module-load time.
    import("src/utilities/logger").then(({ default: log }) => {
        log.warning(
            "[CORS] CORS_ALLOWED_ORIGINS is unset; defaulting to '*' while " +
                "behind a reverse proxy. Restrict to known origins (e.g. " +
                "https://app.example.com) before adding cookies or other " +
                "credential-bearing auth flows.",
        )
    })
}

export const cors = (): Middleware => {
    const allowed = loadCorsAllowedOrigins()
    maybeWarnCorsWildcard(allowed)

    const baseHeaders: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        Vary: "Origin",
    }

    function pickAllowOrigin(req: Request): string | null {
        if (allowed === "*") return "*"
        const reqOrigin = req.headers.get("origin")
        if (!reqOrigin) return null
        const norm = reqOrigin.replace(/\/$/, "").toLowerCase()
        return allowed.includes(norm) ? reqOrigin : null
    }

    return async (req, next) => {
        const allowOrigin = pickAllowOrigin(req)
        const corsHeaders: Record<string, string> = { ...baseHeaders }
        if (allowOrigin) {
            corsHeaders["Access-Control-Allow-Origin"] = allowOrigin
        }

        if (req.method === "OPTIONS") {
            // Preflight: 204 with headers; if origin not allowed, omit
            // the Allow-Origin header (browser will reject) but still
            // return 204 so the request isn't logged as an error.
            return new Response(null, {
                status: 204,
                headers: corsHeaders,
            })
        }

        const response = await next()
        const merged: Record<string, string> = {
            ...corsHeaders,
            ...response.headers.toJSON(),
        }
        // Don't let the upstream response strip our CORS header.
        if (allowOrigin) {
            merged["Access-Control-Allow-Origin"] = allowOrigin
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: merged,
        })
    }
}

export const json = (): Middleware => {
    return async (req, next) => {
        const response = await next()
        if (!response.headers.has("Content-Type")) {
            response.headers.set("Content-Type", "application/json")
        }
        return response
    }
}

// Helper functions for common responses
export const text = (body: string, status = 200): Response => {
    return new Response(body, { status })
}

export const jsonResponse = (
    body: any,
    status = 200,
    extraHeaders?: Record<string, string>,
): Response => {
    // Spread caller-provided headers first, then force Content-Type so it
    // can't be accidentally overridden away from application/json.
    const headers: Record<string, string> = {
        ...extraHeaders,
        "Content-Type": "application/json",
    }
    return new Response(JSON.stringify(body), {
        status,
        headers,
    })
}
