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
import stream from "stream"
import SharedState from "@/utilities/sharedState"

/**
 * A proxy server class that handles HTTP/HTTPS requests by creating a local proxy server.
 * This allows intercepting and forwarding requests to target URLs while managing sessions
 * and handling various protocols and authentication.
 */
export class Proxy {
    private _server: http.Server | https.Server | null = null
    private _proxyPort = 0
    private _isInitialized = false

    constructor(
        private readonly _dahrSessionId: string,
        private readonly _proxyHost: string = "localhost",
        private readonly _authConfig: IAuthorizationConfig = {
            requireAuthForAll: SharedState.getInstance().PROD,
            exceptions: [],
        },
        private readonly _sslConfig: {
            verifyCertificates: boolean
        } = {
            verifyCertificates: SharedState.getInstance().PROD, // Enable in production, disable in dev
        },
    ) {
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
                await this.startProxyServer(targetUrl)
                this._isInitialized = true
            } catch (error) {
                console.error("[Web2API] Error starting proxy server:", error)
                throw error
            }
        }

        return new Promise((resolve, reject) => {
            const { targetHostname, targetPort } = this.parseUrl(targetUrl)
            const headers = this.createHeaders(
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
                method: targetMethod,
                path: "/",
                headers,
                timeout: 30000,
            })
            const chunks: Buffer[] = []
            let responseHeaders: http.IncomingHttpHeaders = {}
            let statusCode = 500
            let statusMessage = "Unknown"

            req.on("response", res => {
                statusCode = res.statusCode || 500
                statusMessage = res.statusMessage || "Unknown"
                responseHeaders = res.headers

                res.on("data", chunk => {
                    chunks.push(Buffer.from(chunk))
                })

                res.on("end", () => {
                    const data = Buffer.concat(chunks).toString()
                    resolve({
                        status: statusCode,
                        statusText: statusMessage,
                        headers: responseHeaders,
                        data: data,
                    })
                })
            })

            req.on("error", error => {
                reject(error)
            })

            if (
                targetMethod !== EnumWeb2Methods.GET &&
                targetMethod !== EnumWeb2Methods.DELETE
            ) {
                req.write(JSON.stringify(payload))
            }

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

    private startProxyServer(targetUrl: string): Promise<void> {
        // Don't create a new server if one is already running
        if (this._server) {
            return Promise.resolve()
        }

        return new Promise((resolve, reject) => {
            this.createNewServer(targetUrl).then(resolve).catch(reject)
        })
    }

    private createNewServer(targetUrl: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const { targetProtocol } = this.parseUrl(targetUrl)

            // Create the proxy server
            const proxyServer = httpProxy.createProxyServer({
                target: targetUrl,
                changeOrigin: true,
                secure:
                    targetProtocol === "https:"
                        ? this._sslConfig.verifyCertificates
                        : false,
                ssl:
                    targetProtocol === "https:"
                        ? {
                              rejectUnauthorized:
                                  this._sslConfig.verifyCertificates,
                          }
                        : undefined,
            })

            // Handle proxy errors
            proxyServer.on("error", (err: any, _req, res) => {
                // Handle SSL certificate errors specifically
                if (
                    err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
                    err.code === "CERT_HAS_EXPIRED" ||
                    err.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
                ) {
                    if (res instanceof http.ServerResponse) {
                        res.writeHead(502, {
                            "Content-Type": "application/json",
                        })
                        res.end(
                            JSON.stringify({
                                error: "SSL Certificate verification failed",
                                message: err.message,
                                code: err.code,
                            }),
                        )
                    }
                    return
                }

                // Handle other proxy errors
                if (res instanceof http.ServerResponse) {
                    res.writeHead(500, {
                        "Content-Type": "application/json",
                    })
                    res.end(
                        JSON.stringify({
                            error: "Proxy error",
                            message: err.message,
                        }),
                    )
                } else if (res instanceof net.Socket) {
                    console.error("[Web2API] Socket error:", err)
                    res.end(
                        "HTTP/1.1 500 Internal Server Error\r\n\r\n" +
                            JSON.stringify({
                                error: "Proxy error",
                                message: err.message,
                            }),
                    )
                }
            })

            // Listen for proxy responses to set the correct status code
            proxyServer.on("proxyRes", (proxyRes, _req, res) => {
                // Set the status code and headers from the target API
                res.writeHead(proxyRes.statusCode || 500, proxyRes.headers)
            })

            // Create the main HTTP server
            this._server = http.createServer((req, res) => {
                if (!this.isAuthorizedRequest(req)) {
                    res.writeHead(403)
                    res.end("Unauthorized")
                    return
                }

                const { targetPathname, targetSearch, targetOrigin } =
                    this.parseUrl(targetUrl)
                const outgoingPath = targetPathname + targetSearch

                // Overwrite req.url with the correct path/query before proxying
                req.url = outgoingPath

                proxyServer.web(req, res, {
                    target: targetOrigin,
                    changeOrigin: true,
                    secure:
                        targetProtocol === "https:"
                            ? this._sslConfig.verifyCertificates
                            : false,
                })
            })

            // Start the server
            this._server.listen(0, "0.0.0.0", () => {
                const address = this._server?.address()
                if (typeof address === "object" && address !== null) {
                    this._proxyPort = address.port
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

    private isAuthorizedRequest(req: http.IncomingMessage): boolean {
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

    private parseUrl(url: string) {
        const parsedUrl = new URL(url)
        return {
            targetProtocol: parsedUrl.protocol,
            targetHostname: parsedUrl.hostname,
            targetPathname: parsedUrl.pathname,
            targetSearch: parsedUrl.search,
            targetFullPath: parsedUrl.pathname + parsedUrl.search,
            targetOrigin: parsedUrl.origin,
            targetPort: parsedUrl.port
                ? Number(parsedUrl.port)
                : parsedUrl.protocol === "https:"
                ? 443
                : parsedUrl.protocol === "http:"
                ? 80
                : undefined,
        }
    }

    private createHeaders(
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

        // Only set Content-Type if not provided by user
        if (
            [
                EnumWeb2Methods.POST,
                EnumWeb2Methods.PUT,
                EnumWeb2Methods.PATCH,
            ].includes(targetMethod) &&
            !headers["Content-Type"]
        ) {
            headers["Content-Type"] = "application/json"
        }

        // Add Authorization if required
        if (this.requiresAuthorization(targetUrl, targetMethod)) {
            headers["Authorization"] = `Bearer ${targetAuthorization}`
        }

        return headers
    }

    private requiresAuthorization(
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

    // Helper function to safely close a socket
    private safelyCloseSocket(socket: net.Socket | stream.Duplex): void {
        try {
            if (!socket.destroyed) {
                if (socket.writable) {
                    socket.end()
                }
                socket.destroy()
            }
        } catch (error) {
            console.error("[Web2API] Error while safely closing socket:", error)
        }
    }
}
