import { Server } from "bun"
import { Headers } from "node-fetch"

export type Handler = (req: Request) => Promise<Response> | Response
export type Middleware = (
    req: Request,
    next: () => Promise<Response>,
) => Promise<Response>

export class BunServer {
    private routes: Map<string, Map<string, Handler>> = new Map()
    private middlewares: Middleware[] = []
    private port: number
    private hostname: string
    private server: Server | null = null

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

    private async handleRequest(req: Request): Promise<Response> {
        const url = new URL(req.url)
        const method = req.method
        const path = url.pathname

        // Apply middlewares
        let response: Response | null = null
        for (const middleware of this.middlewares) {
            response = await middleware(req, async () => {
                const routeHandler = this.routes.get(method)?.get(path)
                if (routeHandler) {
                    return await routeHandler(req)
                }
                return new Response("Not Found", { status: 404 })
            })
            if (response) break
        }

        return response || new Response("Not Found", { status: 404 })
    }

    start(): Server {
        this.server = Bun.serve({
            port: this.port,
            hostname: this.hostname,
            fetch: async req => {
                return await this.handleRequest(req)
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
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }

    return async (req, next) => {
        if (req.method === "OPTIONS") {
            return new Response("OK", { headers: CORS_HEADERS })
        }

        const response = await next()
        return new Response(response.body, { headers: CORS_HEADERS })
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

export const jsonResponse = (body: any, status = 200): Response => {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    })
}
