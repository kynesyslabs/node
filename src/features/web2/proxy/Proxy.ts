import https from "https"
import http from "http"
import forge from "node-forge"
import httpProxy from "http-proxy"
import { URL } from "url"
import axios, { AxiosResponseHeaders, RawAxiosResponseHeaders } from "axios"

import required from "src/utilities/required"
import { DAHR } from "../dahr/DAHR"

// TODO Move this to the SDK
export interface IParam {
    name: string // Ignored in POST requests
    value: any
}

// TODO Move this to the SDK
export interface IRawWeb2Request {
    action: string
    parameters: IParam[]
    requestedParameters: [] | null
    method: EnumWeb2Methods
    url: string
    headers: any
    minAttestations: number
    // Handling the various stages of an IWeb2Request
    stage: {
        // The one that will handle the response too
        origin: {
            identity: forge.pki.ed25519.BinaryBuffer
            connection_url: string
        }
        // Starting from 0, each attestation it is increased
        hop_number: number
    }
}

// TODO Move this to the SDK
export interface IWeb2Request {
    raw: IRawWeb2Request
    result: any
    attestations: {}
    hash: string
    signature?: forge.pki.ed25519.BinaryBuffer
}

// TODO Move this to the SDK
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

export class Proxy {
    private _proxyServer: httpProxy

    constructor(
        private readonly _sessionId: string,
        private readonly _targetUrl: string,
    ) {
        required(this._sessionId, "Missing sessionId")
        required(this._targetUrl, "Missing targetUrl")
    }

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

    async sendHTTPRequest(
        web2Request: IWeb2Request,
        targetPath: string = "/",
        targetMethod: EnumWeb2Methods = EnumWeb2Methods.GET,
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
            // TODO: Remove this when the target is HTTPS
            const httpsAgent = new https.Agent({
                rejectUnauthorized: false, // Note: This is not recommended for production
            })
            const response = await axios({
                method: targetMethod,
                url: fullUrl,
                headers: {
                    ...web2Request.raw.headers,
                    Host: new URL(targetUrl).host, // Ensure the correct Host header is set
                },
                httpsAgent,
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
            throw error
        }
    }

    stopProxy(): void {
        required(this._proxyServer, "[Web2API] No proxy server to stop")

        console.log("[Web2API] Stopping proxy server")
        this._proxyServer.close()
    }

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
