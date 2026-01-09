import https from "https"
import http from "http"
import httpProxy from "http-proxy"
import { URL } from "url"
import net from "net"
import dns from "node:dns/promises"
import {
    IWeb2Request,
    IWeb2Result,
    IAuthorizationConfig,
    ISendHTTPRequestParams,
    Web2Method,
} from "@kynesyslabs/demosdk/types"
import required from "src/utilities/required"
import SharedState from "@/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import log from "@/utilities/logger"

/**
 * A proxy server class that handles HTTP/HTTPS requests by creating a local proxy server.
 * This allows intercepting and forwarding requests to target URLs while managing sessions
 * and handling various protocols and authentication.
 */
export class Proxy {
    private _server: http.Server | https.Server | null = null
    private _proxyPort = 0
    private _isInitialized = false
    private _currentTargetUrl = ""

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
        const targetUrl = web2Request.raw.url
        required(web2Request.raw, "web2Request.raw")

        // Only initialize the proxy server if it's not already running or the target URL has changed
        if (!this._isInitialized || this._currentTargetUrl !== targetUrl) {
            try {
                await this.startProxyServer(targetUrl)
                this._isInitialized = true
                this._currentTargetUrl = targetUrl
            } catch (error) {
                log.error("[Web2API] Error starting proxy server:", error)
                throw error
            }
        }

        return new Promise((resolve, reject) => {
            const headers = this.createHeaders(
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
            let requestHash: string | undefined

            req.on("response", res => {
                statusCode = res.statusCode || 500
                statusMessage = res.statusMessage || "Unknown"
                responseHeaders = res.headers

                res.on("data", chunk => {
                    chunks.push(Buffer.from(chunk))
                })

                res.on("end", () => {
                    const dataBuffer = Buffer.concat(chunks)
                    const data = dataBuffer.toString()

                    // Create a hash over the exact UTF-8 bytes of the returned string data
                    const responseHash = Hashing.sha256Bytes(
                        Buffer.from(data, "utf8"),
                    )
                    const responseHeadersHash = Hashing.sha256(
                        this.canonicalizeHeaders(responseHeaders),
                    )

                    resolve({
                        status: statusCode,
                        statusText: statusMessage,
                        headers: responseHeaders,
                        data: data,
                        responseHash: responseHash,
                        responseHeadersHash: responseHeadersHash,
                        // Optional: include requestHash when a body was sent
                        ...(requestHash ? { requestHash } : {}),
                    })
                })
            })

            req.on("error", error => {
                reject(error)
            })

            if (payload != null && !["GET", "DELETE"].includes(targetMethod)) {
                const body =
                    typeof payload === "string"
                        ? payload
                        : JSON.stringify(payload)
                // Compute hash over the exact bytes we are about to transmit
                requestHash = Hashing.sha256Bytes(Buffer.from(body, "utf8"))
                ;(req as any).setHeader(
                    "Content-Length",
                    Buffer.byteLength(body),
                )
                req.write(body)
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
    async stopProxy(): Promise<void> {
        const srv = this._server
        if (!srv) {
            this._isInitialized = false
            return
        }
        await new Promise<void>(resolve => {
            srv.close(() => {
                // Only clear if we're still closing the same server
                if (this._server === srv) {
                    this._server = null
                    this._isInitialized = false
                }
                resolve()
            })
        })
    }

    private async startProxyServer(targetUrl: string): Promise<void> {
        if (this._isInitialized) {
            await this.stopProxy()
        }
        await this.createNewServer(targetUrl)
    }

    private async createNewServer(targetUrl: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const { targetProtocol, targetHostname } = this.parseUrl(targetUrl)

            // SSRF hardening: resolve DNS and block private/link-local/loopback destinations
            const isDisallowedAddress = (addr: string): boolean => {
                const lower = addr.toLowerCase()
                const ipVersion = net.isIP(lower)

                // Helper for IPv4 space
                const isDisallowedV4 = (v4: string): boolean => {
                    if (/^127(?:\.\d{1,3}){3}$/.test(v4)) return true // loopback
                    if (/^10\./.test(v4)) return true // private
                    const m = v4.match(/^172\.(\d{1,3})\./)
                    if (m) {
                        const o = Number(m[1])
                        if (o >= 16 && o <= 31) return true
                    }
                    if (/^192\.168\./.test(v4)) return true // private
                    if (/^169\.254\./.test(v4)) return true // link-local
                    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4))
                        return true // CGNAT 100.64/10
                    if (/^0\./.test(v4)) return true // this network
                    if (/^(?:22[4-9]|23\d)\./.test(v4)) return true // multicast 224/4
                    if (/^(?:24\d|25[0-5])\./.test(v4)) return true // reserved 240/4 incl 255.255.255.255
                    return false
                }

                if (ipVersion === 6) {
                    if (lower === "::" || lower === "::1") return true // unspecified/loopback
                    if (lower.startsWith("ff")) return true // multicast ff00::/8
                    // ULA fc00::/7
                    if (lower.startsWith("fc") || lower.startsWith("fd"))
                        return true
                    // Link-local fe80::/10 → fe8x, fe9x, feax, febx
                    if (/^fe[89ab][0-9a-f]*:/i.test(lower)) return true
                    // IPv4-mapped IPv6 ::ffff:a.b.c.d → re-check mapped v4
                    const v4map = lower.match(
                        /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/,
                    )
                    if (v4map && isDisallowedV4(v4map[1])) return true
                    return false
                }

                if (ipVersion === 4) {
                    return isDisallowedV4(lower)
                }
                return false
            }

            const preflight = async () => {
                try {
                    // If hostname is already an IP, just check it; otherwise resolve all
                    const ipVersion = net.isIP(targetHostname)
                    if (ipVersion) {
                        if (isDisallowedAddress(targetHostname)) {
                            throw new Error(
                                "Target resolves to a private/link-local/loopback address",
                            )
                        }
                    } else {
                        const answers = await dns.lookup(targetHostname, {
                            all: true,
                        })
                        if (answers.some(a => isDisallowedAddress(a.address))) {
                            throw new Error(
                                "Target resolves to a private/link-local/loopback address",
                            )
                        }
                    }
                } catch (e) {
                    reject(e)
                    return false
                }
                return true
            }

            // Create the proxy server (defaults; per-request options are supplied in proxyServer.web)
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
                    log.error("[Web2API] Socket error:", err)
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
            this._server = http.createServer(async (req, res) => {
                if (!this.isAuthorizedRequest(req)) {
                    res.writeHead(403)
                    res.end("Unauthorized")
                    return
                }

                // Ensure target is still safe at request time (DNS may have changed)
                const ok = await preflight()
                if (!ok) {
                    res.writeHead(400)
                    res.end("Invalid target host")
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
                log.error("[Web2API] HTTP Server error:", error)
                reject(error)
            })
        })
    }

    private isAuthorizedRequest(req: http.IncomingMessage): boolean {
        const sessionIdHeader = req.headers["x-dahr-session-id"]
        const url = req.url || ""
        const method = req.method as Web2Method

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
        targetMethod: Web2Method,
        targetHeaders: IWeb2Request["raw"]["headers"],
        targetAuthorization: string,
        targetUrl: string,
    ): IWeb2Request["raw"]["headers"] {
        // Base headers - only essential ones
        const headers: IWeb2Request["raw"]["headers"] = {
            "x-dahr-session-id": this._dahrSessionId,
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
            ["POST", "PUT", "PATCH"].includes(targetMethod) &&
            !headers["Content-Type"]
        ) {
            headers["Content-Type"] = "application/json"
        }

        // Default to identity encoding for deterministic response bytes if not set by caller
        const hasAcceptEncoding = Object.keys(headers).some(
            k => k.toLowerCase() === "accept-encoding",
        )
        if (!hasAcceptEncoding) {
            headers["Accept-Encoding"] = "identity"
        }

        // Add Authorization if required
        if (this.requiresAuthorization(targetUrl, targetMethod)) {
            headers["Authorization"] = `Bearer ${targetAuthorization}`
        }

        return headers
    }

    /**
     * Canonicalize headers for deterministic hashing:
     * - Lowercase keys
     * - Omit volatile headers (date, set-cookie)
     * - Join array values with ", "
     * - Trim whitespace
     * - Sort by key
     */
    private canonicalizeHeaders(headers: http.IncomingHttpHeaders): string {
        const volatile = new Set([
            "date",
            "set-cookie",
            "connection",
            "keep-alive",
            "transfer-encoding",
            "upgrade",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "via",
            "warning",
            "server",
            // Optional: content-length can vary across intermediaries
            "content-length",
        ]) // omit volatile/hop-by-hop headers
        const entries: Array<{ key: string; value: string }> = []
        for (const [rawKey, rawVal] of Object.entries(headers)) {
            const key = rawKey.toLowerCase()
            if (volatile.has(key)) continue
            if (rawVal == null) continue
            let value: string
            if (Array.isArray(rawVal)) {
                value = rawVal.join(", ")
            } else {
                value = String(rawVal)
            }
            entries.push({ key, value: value.trim() })
        }
        entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        return entries.map(e => `${e.key}:${e.value}`).join("\n")
    }

    private requiresAuthorization(url: string, method: Web2Method): boolean {
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
