import { Server } from "bun"
import { Headers } from "node-fetch"
import log from "@/utilities/logger"

export type BunRequest = Request & {
    params?: Record<string, string>
}

export type Handler = (req: BunRequest) => Promise<Response> | Response
export type Middleware = (
    req: BunRequest,
    next: () => Promise<Response>,
    server?: Server,
) => Promise<Response>

type ParamRoute = {
    path: string
    segments: string[]
    handler: Handler
}

export class BunServer {
    private routes: Map<string, Map<string, Handler>> = new Map()
    private paramRoutes: Map<string, ParamRoute[]> = new Map()
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
        if (path.includes("/:")) {
            if (!this.paramRoutes.has(method)) {
                this.paramRoutes.set(method, [])
            }
            this.paramRoutes.get(method)!.push({
                path,
                segments: path.split("/").filter(Boolean),
                handler,
            })
            return
        }
        if (!this.routes.has(method)) {
            this.routes.set(method, new Map())
        }
        this.routes.get(method)?.set(path, handler)
    }

    private matchParamRoute(method: string, pathname: string): {
        handler: Handler
        params: Record<string, string>
    } | null {
        const candidates = this.paramRoutes.get(method)
        if (!candidates || candidates.length === 0) return null

        const requestSegments = pathname.split("/").filter(Boolean)

        for (const route of candidates) {
            if (route.segments.length !== requestSegments.length) continue
            const params: Record<string, string> = {}
            let matched = true

            for (let i = 0; i < route.segments.length; i++) {
                const routeSeg = route.segments[i]
                const reqSeg = requestSegments[i]

                if (routeSeg.startsWith(":")) {
                    params[routeSeg.slice(1)] = decodeURIComponent(reqSeg)
                    continue
                }

                if (routeSeg !== reqSeg) {
                    matched = false
                    break
                }
            }

            if (matched) {
                return { handler: route.handler, params }
            }
        }

        return null
    }

    private async handleRequest(
        req: BunRequest,
        server?: Server,
    ): Promise<Response> {
        const url = new URL(req.url)
        const method = req.method
        const path = url.pathname

        // Create the final handler (route handler)
        const finalHandler = async (): Promise<Response> => {
            let routeHandler = this.routes.get(method)?.get(path)
            if (!routeHandler) {
                const match = this.matchParamRoute(method, path)
                if (match) {
                    routeHandler = match.handler
                    req.params = match.params
                }
            }
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

export const jsonResponse = (body: any, status = 200): Response => {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    })
}
