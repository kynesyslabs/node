import { Server } from "bun"
import { Headers } from "node-fetch"
import log from "@/utilities/logger"

export type Handler = (req: Request) => Promise<Response> | Response
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

    private async handleRequest(
        req: Request,
        server?: Server,
    ): Promise<Response> {
        const url = new URL(req.url)
        const method = req.method
        const path = url.pathname

        // Create the final handler (route handler)
        const finalHandler = async (): Promise<Response> => {
            const routeHandler = this.routes.get(method)?.get(path)
            if (routeHandler) {
                return await routeHandler(req)
            }
            return new Response("Not Found", { status: 404 })
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

// Helper functions for common middleware
export const cors = (): Middleware => {
    let headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }

    return async (req, next) => {
        if (req.method === "OPTIONS") {
            return new Response("OK", { headers: headers })
        }

        const response = await next()
        headers = { ...headers, ...response.headers.toJSON() }

        return new Response(response.body, {
            headers: headers,
        })
    }
}

export const json = (): Middleware => {
    return async (req, next) => {
        const response = await next()
        response.headers.set("Content-Type", "application/json")
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
