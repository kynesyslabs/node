import https from "https"
import http from "http"
import httpProxy from "http-proxy"
import required from "src/utilities/required"
import axios from "axios"
import forge from "node-forge"

import { DAHR } from "./DAHR"

import terminalKit from "terminal-kit"

const term = terminalKit.terminal

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

export class Proxy {
    constructor(private dahr: DAHR) {
        required(this.dahr, "Missing DAHR instance")
    }

    /**
     * The proxy server used to forward HTTP requests.
     * @type {httpProxy}
     */
    private proxyServer: httpProxy
    /**
     * The target URL where the HTTP request will be sent.
     * @type {string}
     */
    private target: string
    private targetProtocol: string
    private targetHostname: string
    private targetPort: number

    private createProxyServer(source: string, target: string): void {
        term.yellow.bold(
            "[Web2API] Creating a proxy server with source " +
                source +
                " and target " +
                target +
                "...\n",
        )

        // Parse the target URL to get the protocol, hostname, and port
        const { protocol, hostname, port } = parseUrl(target)
        this.targetProtocol = protocol
        this.targetHostname = hostname
        this.targetPort = port

        this.proxyServer = httpProxy.createProxyServer({
            target: {
                protocol: this.targetProtocol,
                host: this.targetHostname,
                port: this.targetPort,
            },
        })

        term.yellow.bold("[Web2API] Proxy server created. \n")
        console.log(this.proxyServer)

        // Parse the source URL to get the protocol, hostname, and port
        const {
            protocol: hostProtocol,
            hostname: sourceHostname,
            port: sourcePort,
        } = parseUrl(source)

        // Create an HTTP or HTTPS proxy server based on the hostProtocol
        if (hostProtocol === "http:") {
            http.createServer((req, res) => {
                this.proxyServer.web(req, res)
            }).listen(sourcePort, sourceHostname)
        } else if (hostProtocol === "https:") {
            https
                .createServer((req, res) => {
                    this.proxyServer.web(req, res)
                })
                .listen(sourcePort, sourceHostname)
        } else {
            console.error("Unsupported hostProtocol: " + hostProtocol)
        }
    }

    /**
     * Send a HTTP request.
     * @param {string} source - The source where the proxy server will listen for incoming requests.
     * @param {string} web2Request - Contains the target URL where the HTTP request will be sent.
     * @param {string} targetPath - The targetPath.
     * @param {string} targetMethod - The HTTP method that the proxy should call.
     * @returns {Promise<any>} A HTTP promise.
     */
    sendHTTPRequest(
        source: string,
        web2Request: IWeb2Request,
        targetPath: string = "/",
        targetMethod: EnumWeb2Methods = EnumWeb2Methods.GET,
        // TODO Need to type web2Result somehow
    ): Promise<any> {
        console.log("sendHTTPRequest called")

        const targetBody = web2Request.raw
        this.target = web2Request.raw.url
        this.createProxyServer(source, this.target)
        // TODO Will need to take into consideration the case where the method is "GET" on the first hop.
        if (!targetBody && !(targetMethod === "GET")) {
            term.yellow.bold(
                "[Web2API] No raw request attached. Is this right? \n",
            )
            // TODO Specify this as a parameter that users can set
            this.dahr.web2Request.raw.minAttestations = 10
            this.dahr.web2Request.raw.stage.hopNumber = 0
        } else {
            this.dahr.web2Request.raw = targetBody
        }

        try {
            return new Promise((resolve, reject) => {
                console.log("Promise started")
                const options = {
                    hostname: this.targetHostname,
                    baseURL: `${this.targetProtocol}//${this.targetHostname}`,
                    // TODO Need to pass targetPort as a parameter
                    /* port: this.targetPort || (this.targetProtocol === "https:" ? 443 : 80), */
                    url: targetPath,
                    method: targetMethod,
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(
                            JSON.stringify(targetBody),
                        ),
                    },
                    data: targetBody,
                }

                axios(options)
                    .then(res => {
                        console.log("Response received")
                        console.log("Response ended")
                        resolve(res.data)
                    })
                    .catch(error => {
                        console.error("Request error", error)
                        reject(error)
                    })
            }).catch(error => {
                console.error("Error in Promise", error)
            })
        } catch (error) {
            console.error("Error in sendHTTPRequest", error)
        }
    }

    stopProxy(): void {
        required(this.proxyServer, "Proxy server has not been started.")
        term.yellow.bold(
            "[Web2API] Stopping proxy server with target " + this.target,
        )

        this.proxyServer.close()
    }
}

function parseUrl(url: string) {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname
    const port = Number(parsedUrl.port)
    const protocol = parsedUrl.protocol

    return { protocol, hostname, port }
}
