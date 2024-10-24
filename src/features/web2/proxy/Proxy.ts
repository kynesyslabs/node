import https from "https"
import http from "http"
import httpProxy from "http-proxy"
import { URL } from "url"
import axios, { AxiosResponseHeaders, RawAxiosResponseHeaders } from "axios"
import { IWeb2Request } from "@kynesyslabs/demosdk/types"

import required from "src/utilities/required"

// TODO Export this from the SDK
export enum EnumWeb2Methods {
    GET = "GET",
    POST = "POST",
    PUT = "PUT",
    DELETE = "DELETE",
    PATCH = "PATCH",
}

// TODO Move this to the SDK
export interface IWeb2Result {
    status: number
    statusText: string
    headers: AxiosResponseHeaders | RawAxiosResponseHeaders
    data: any
}

/**
 * The Proxy class is responsible for creating and managing the proxy server.
 */
export class Proxy {
    private _proxyServer: httpProxy

    constructor(
        private readonly _dahrSessionId: string,
        private readonly _targetUrl: string,
    ) {
        required(this._dahrSessionId, "Missing dahr session Id")
        required(this._targetUrl, "Missing targetUrl")
    }

    /**
     * Creates the proxy server.
     * @param target - The target URL.
     */
    private createProxyServer(target: string): void {
        console.log(`[Web2API] Creating a proxy server for target ${target}`)

        const { protocol, hostname, port } = this._parseUrl(target)

        const options: httpProxy.ServerOptions = {
            target: { protocol, host: hostname, port },
            changeOrigin: true,
        }

        if (protocol === "https:") {
            options.ssl = {
                // TODO Add your SSL options here if needed
                rejectUnauthorized: false, // Use this only for development/testing
            }
        }

        this._proxyServer = httpProxy.createProxyServer(options)

        this._proxyServer.on("error", (err, req, res) => {
            console.error("[Web2API] Proxy error:", err)
            console.error("[Web2API] Request details:", {
                method: req.method,
                url: req.url,
                headers: req.headers,
            })
            if (res instanceof http.ServerResponse) {
                res.writeHead(500, { "Content-Type": "text/plain" })
                res.end("Proxy error")
            }
        })

        this._proxyServer.on("proxyReq", (proxyReq, req, res, options) => {
            console.log("[Web2API] Proxying request:", {
                method: req.method,
                url: req.url,
                targetUrl: options.target,
            })
        })

        this._proxyServer.on("proxyRes", (proxyRes, req, res) => {
            console.log("[Web2API] Received response from target:", {
                statusCode: proxyRes.statusCode,
                headers: proxyRes.headers,
            })
        })

        this._proxyServer.on("proxyRes", (proxyRes, req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*")
            res.setHeader(
                "Access-Control-Allow-Methods",
                "GET,PUT,POST,DELETE,OPTIONS",
            )
            res.setHeader(
                "Access-Control-Allow-Headers",
                "Origin, X-Requested-With, Content-Type, Accept",
            )
        })

        console.log("[Web2API] Proxy server created")
    }

    /**
     * Sends an HTTP request through the proxy.
     * @param web2Request - The Web2 request.
     * @param targetPath - The target path.
     * @param targetMethod - The target method.
     * @returns The Web2 result.
     */
    async sendHTTPRequest(
        web2Request: IWeb2Request,
        targetPath: string = "/",
        targetMethod: EnumWeb2Methods,
    ): Promise<IWeb2Result> {
        required(web2Request.raw, "web2Request.raw")
        required(web2Request.raw.url, "web2Request.raw.url")
        required(
            web2Request.raw.url === this._targetUrl,
            "Proxy can only be used for its specific target URL",
        )

        const targetUrl = web2Request.raw.url
        this.createProxyServer(targetUrl)

        const { protocol, hostname, port } = this._parseUrl(targetUrl)
        const fullUrl = `${protocol}//${hostname}${
            port ? `:${port}` : ""
        }${targetPath}`

        try {
            const response = await axios({
                method: targetMethod,
                url: fullUrl,
                headers: {
                    ...web2Request.raw.headers,
                    Host: new URL(targetUrl).host,
                },
                data:
                    targetMethod !== EnumWeb2Methods.GET
                        ? web2Request.raw
                        : undefined,
            })

            return {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                data: response.data,
            }
        } catch (error) {
            console.error("Error in sendHTTPRequest", error)
            if (axios.isAxiosError(error)) {
                console.error("Axios error details:", error.response?.data)
                console.error("Axios error status:", error.response?.status)
            }
            if (
                axios.isAxiosError(error) &&
                error.code === "CERT_HAS_EXPIRED"
            ) {
                console.warn(
                    "The target server has an expired SSL certificate:",
                    targetUrl,
                )
                // Handle this case as needed, maybe return a specific error to the client
            }
            throw error
        }
    }

    /**
     * Stops the proxy server.
     */
    stopProxy(): void {
        required(this._proxyServer, "[Web2API] No proxy server to stop")

        console.log("[Web2API] Stopping proxy server")
        this._proxyServer.close()
    }

    /**
     * Parses the URL to extract the protocol, hostname, and port.
     * @param url - The URL to parse.
     * @returns The parsed URL details.
     */
    private _parseUrl(url: string) {
        const parsedUrl = new URL(url)
        return {
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port
                ? Number(parsedUrl.port)
                : parsedUrl.protocol === "https:"
                ? 443
                : parsedUrl.protocol === "http:"
                ? 80
                : undefined,
        }
    }
}
