import https from "https"
import http from "http"
import httpProxy from "http-proxy"
import { URL } from "url"
import net from "net"
import {
    IWeb2Request,
    EnumWeb2Methods,
    IWeb2Result,
    IAuthorizationConfig,
    ISendHTTPRequestParams,
} from "@kynesyslabs/demosdk/types"
import required from "src/utilities/required"

/**
 * A proxy server class that handles HTTP/HTTPS requests by creating a local proxy server.
 * This allows intercepting and forwarding requests to target URLs while managing sessions
 * and handling various protocols and authentication.
 */
export class Proxy {
    private _server: http.Server | https.Server | null = null
    private _proxyPort = 0
    private _isInitialized = false
    private readonly _authConfig: IAuthorizationConfig = {
        requireAuthForAll: true,
        exceptions: [],
    }

    constructor(
        private readonly _dahrSessionId: string,
        private readonly _proxyHost: string = "localhost",
        authorizationConfig?: {
            requireAuthForAll: boolean
            exceptions: Array<{
                urlPattern: RegExp
                methods: EnumWeb2Methods[]
            }>
        },
    ) {
        this._authConfig = authorizationConfig || {
            requireAuthForAll: false, // TODO: Set to true before production
            exceptions: [],
        }
        required(this._dahrSessionId, "Missing dahr session Id")
    }

    /**
     * Sends an HTTP/HTTPS request through the proxy.
     * @returns Promise resolving to the response data
     * @throws Error if the proxy server fails to start or if the request fails
     */
    async sendHTTPRequest(
        params: ISendHTTPRequestParams,
    ): Promise<IWeb2Result> {
        const {
            web2Request,
            targetMethod,
            targetHeaders,
            payload,
            targetAuthorization,
        } = params
        required(web2Request.raw, "web2Request.raw")

        const targetUrl = web2Request.raw.url || ""

        // Only initialize the proxy server if it's not already running
        if (!this._isInitialized) {
            try {
                await this._startProxyServer(targetUrl)
                this._isInitialized = true
            } catch (error) {
                console.error("[Web2API] Error starting proxy server:", error)
                throw error
            }
        }

        return new Promise((resolve, reject) => {
            const { targetProtocol, targetHostname, targetPort } =
                this._parseUrl(targetUrl)
            const headers = this._createHeaders(
                targetHostname,
                targetPort,
                targetMethod,
                targetHeaders,
                targetAuthorization,
                targetUrl,
            )

            const req = http.request({
                hostname: this._proxyHost,
                port: this._proxyPort,
                method: targetProtocol === "https:" ? "CONNECT" : targetMethod,
                path: `${targetHostname}:${targetPort}`,
                headers,
                timeout: 30000,
                agent: false,
            })

            req.on("connect", (res, socket) => {
                if (res.statusCode !== 200) {
                    socket.destroy()
                    reject(
                        new Error(
                            `Tunnel connection failed: ${res.statusCode}`,
                        ),
                    )
                    return
                }

                // For HTTPS, establish the tunnel
                const options = {
                    host: targetHostname,
                    port: targetPort,
                    method: targetMethod,
                    path:
                        new URL(targetUrl).pathname + new URL(targetUrl).search,
                    headers,
                    socket: socket,
                    agent: false,
                }

                const httpsReq = https.request(options, httpsRes => {
                    let data = ""
                    httpsRes.on("data", chunk => (data += chunk))
                    httpsRes.on("end", () => {
                        resolve({
                            status: httpsRes.statusCode || 500,
                            statusText: httpsRes.statusMessage || "Unknown",
                            headers: httpsRes.headers,
                            data: data,
                        })
                    })
                })

                httpsReq.on("error", err => {
                    console.error("[Web2API] HTTPS request error:", err)
                    socket.destroy()
                    reject(err)
                })

                if (
                    targetMethod !== EnumWeb2Methods.GET &&
                    targetMethod !== EnumWeb2Methods.DELETE
                ) {
                    httpsReq.write(JSON.stringify(payload))
                }

                httpsReq.end()
            })

            req.on("error", error => {
                console.error("[Web2API] Request error:", error)

                reject(error)
            })

            req.end()
        })
    }

    /**
     * Stops the proxy server and cleans up resources.
     * This method should be called when the proxy is no longer needed.
     * It stops the proxy server and closes any open connections.
     * @returns void
     */
    stopProxy(): void {
        if (this._server) {
            this._server.close(() => {
                console.log("[Web2API] Proxy server stopped")
                this._isInitialized = false
                this._server = null
            })

            // Force close any hanging connections
            this._server.closeAllConnections()
        }
    }

    /**
     * Gets the URL of the proxy server.
     * @returns The URL of the proxy server.
     */
    get proxyUrl(): string {
        if (!this._server) {
            throw new Error("Proxy server is not running")
        }
        const address = this._server.address()
        if (typeof address === "object" && address !== null) {
            return `http://${address.address}:${address.port}`
        }
        throw new Error("Unable to determine proxy server address")
    }

    private _startProxyServer(targetUrl: string): Promise<void> {
        // Don't create a new server if one is already running
        if (this._server) {
            return Promise.resolve()
        }

        return new Promise((resolve, reject) => {
            this._createNewServer(targetUrl).then(resolve).catch(reject)
        })
    }

    private _createNewServer(targetUrl: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const { targetProtocol, targetHostname, targetPort } =
                this._parseUrl(targetUrl)

            // Create the proxy server
            const proxyServer = httpProxy.createProxyServer({
                target: {
                    protocol: targetProtocol,
                    host: targetHostname,
                    port: targetPort,
                },
                changeOrigin: true,
                secure: false, // TODO: Enable SSL certificate verification before production
                ssl:
                    targetProtocol === "https:"
                        ? { rejectUnauthorized: false }
                        : undefined, // TODO: Properly handle SSL certificate verification in production
            })

            // Handle proxy errors
            proxyServer.on("error", (err, req, res) => {
                console.error("[Web2API] Proxy server error:", err)
                if (res instanceof http.ServerResponse) {
                    console.log("[Web2API] Writing response")
                    res.writeHead(500, {
                        "Content-Type": "text/plain",
                    })
                    res.end("Something went wrong with the proxy.")
                } else if (res instanceof net.Socket) {
                    console.error("[Web2API] Socket error:", err)
                    res.end(
                        "HTTP/1.1 500 Internal Server Error\r\n\r\nSomething went wrong with the proxy.",
                    )
                }
            })

            // Create the main HTTP server
            this._server = http.createServer((req, res) => {
                if (!this._isAuthorizedRequest(req)) {
                    res.writeHead(403)
                    res.end("Unauthorized")
                    return
                }
                proxyServer.web(req, res)
            })

            // Handle HTTPS CONNECT
            this._server.on("connect", (req, clientSocket, head) => {
                if (!this._isAuthorizedRequest(req)) {
                    clientSocket.write(
                        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nUnauthorized request",
                    )
                    clientSocket.destroy()
                    return
                }

                const [targetHost, targetPort] = req.url.split(":")
                const targetSocket = net.connect(
                    parseInt(targetPort) || 443,
                    targetHost,
                    () => {
                        clientSocket.write(
                            "HTTP/1.1 200 Connection Established\r\n" +
                                "Proxy-agent: DAHR-Proxy\r\n" +
                                "\r\n",
                        )

                        targetSocket.write(head)
                        targetSocket.pipe(clientSocket)
                        clientSocket.pipe(targetSocket)
                    },
                )

                targetSocket.on("error", err => {
                    console.error("[Web2API] Target connection error:", err)
                    clientSocket.end()
                })

                clientSocket.on("error", err => {
                    console.error("[Web2API] Client connection error:", err)
                    targetSocket.end()
                })

                targetSocket.on("end", () => {
                    clientSocket.end()
                })

                clientSocket.on("end", () => {
                    targetSocket.end()
                })
            })

            // Start the server
            this._server.listen(0, "0.0.0.0", () => {
                const address = this._server?.address()
                if (typeof address === "object" && address !== null) {
                    this._proxyPort = address.port
                    console.log(
                        `[Web2API] Proxy server running at http://127.0.0.1:${this._proxyPort}/`,
                    )
                    resolve()
                } else {
                    reject(new Error("[Web2API] Failed to get server address"))
                }
            })

            // Error handling for the main HTTP server
            this._server.on("error", error => {
                console.error("[Web2API] HTTP Server error:", error)
                reject(error)
            })
        })
    }

    private _isAuthorizedRequest(req: http.IncomingMessage): boolean {
        const sessionIdHeader = req.headers["x-dahr-session-id"]
        const url = req.url || ""
        const method = req.method as EnumWeb2Methods

        // Check if this URL/method combination is in exceptions
        const isExempt = this._authConfig.exceptions.some(
            exception =>
                exception.urlPattern.test(url) &&
                exception.methods.includes(method),
        )

        if (isExempt) {
            return true
        }

        if (this._authConfig.requireAuthForAll) {
            return (
                typeof sessionIdHeader === "string" &&
                sessionIdHeader === this._dahrSessionId
            )
        }

        return true
    }

    private _parseUrl(url: string) {
        const parsedUrl = new URL(url)
        return {
            targetProtocol: parsedUrl.protocol,
            targetHostname: parsedUrl.hostname,
            targetPort: parsedUrl.port
                ? Number(parsedUrl.port)
                : parsedUrl.protocol === "https:"
                ? 443
                : parsedUrl.protocol === "http:"
                ? 80
                : undefined,
        }
    }

    private _createHeaders(
        targetHostname: string,
        targetPort: number,
        targetMethod: EnumWeb2Methods,
        targetHeaders: IWeb2Request["raw"]["headers"],
        targetAuthorization: string,
        targetUrl: string,
    ): IWeb2Request["raw"]["headers"] {
        // Base headers
        const headers: IWeb2Request["raw"]["headers"] = {
            Host: `${targetHostname}:${targetPort}`,
            "x-dahr-session-id": this._dahrSessionId,
            Connection: "keep-alive",
        }

        // Convert all targetHeaders values to strings
        for (const [key, value] of Object.entries(targetHeaders)) {
            if (Array.isArray(value)) {
                headers[key] = value.join(", ")
            } else if (value !== undefined) {
                headers[key] = value.toString()
            }
        }

        // Add Content-Type for methods with a body
        if (
            [
                EnumWeb2Methods.POST,
                EnumWeb2Methods.PUT,
                EnumWeb2Methods.PATCH,
            ].includes(targetMethod)
        ) {
            headers["Content-Type"] = "application/json"
        }

        // Add Authorization if required
        if (this._requiresAuthorization(targetUrl, targetMethod)) {
            headers["Authorization"] = `Bearer ${targetAuthorization}`
        }

        return headers
    }

    private _requiresAuthorization(
        url: string,
        method: EnumWeb2Methods,
    ): boolean {
        if (this._authConfig.requireAuthForAll) {
            for (const exception of this._authConfig.exceptions) {
                if (
                    exception.urlPattern.test(url) &&
                    exception.methods.includes(method)
                ) {
                    return false
                }
            }
            return true
        }
        return false
    }
}
