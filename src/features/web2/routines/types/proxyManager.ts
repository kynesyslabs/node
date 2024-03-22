// LINK https://stackoverflow.com/questions/46412934/forward-https-traffic-thru-nginx-without-ssl-certificate
// LINK https://github.com/http-party/node-http-proxy
// LINK https://github.com/http-party/node-http-proxy?tab=readme-ov-file#https---https
import httpProxy from "http-proxy"
import fs from "fs"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import sharedState from "src/utilities/sharedState"
import required from "src/utilities/required"

export interface IHTTPSCerts {
    key: string
    cert: string
}


export default class proxyManager {
    // TODO Persist this registry
    private static _proxies: Map<string, proxyManager> = new Map()

    // Properties
    public proxid: string
    public port: number
    public is_secure: boolean
    public target: string
    public isOn: boolean = false

    // State
    private internal_proxy: httpProxy = null

    // Constructor for instances
    constructor(
        port: number,
        target: string,
        is_secure: boolean = true,
        proxid: string = null,
    ) {
        if (proxid) {
            this.proxid = proxid
        } else {
            this.proxid = Math.random().toString(36).substring(7)
        }
        proxyManager._proxies.set(this.proxid, this)
    }

    // Singleton logic
    static getProxy(id: string): proxyManager {
        if (this._proxies.has(id)) {
            return this._proxies.get(id)
        } else {
            throw new Error("Proxy not found")
        }
    }

    // Methods

    // NOTE Get the proxy instance and connection status
    public state(): { proxy: httpProxy; isOn: boolean } {
        return { proxy: this.internal_proxy, isOn: this.isOn }
    }

    // NOTE Run the proxy with the specified properties
    public run(
        certs: IHTTPSCerts = {
            key: "src/features/web2/routines/certs/key.pem",
            cert: "src/features/web2/routines/certs/cert.pem",
        },
    ): httpProxy {
        this.internal_proxy = httpProxy
            .createServer({
                ssl: {
                    key: fs.readFileSync(certs.key, "utf8"),
                    cert: fs.readFileSync(certs.cert, "utf8"),
                },
                target: this.target,
                secure: this.is_secure, // Depends on the target
            })
            .listen(this.port)
        console.log(
            "Proxy server listening on port " +
                this.port.toString() +
                " with id " +
                this.proxid,
        )
        // Informing everyone that we are listening
        this.isOn = true
        // Activate listeners
        this.listenersForProxy()
        return this.internal_proxy
    }

    private listenersForProxy() {
        required(this.isOn, "Proxy is not running")
        // TODO Add listeners for the proxy based on this blurbprint
        this.internal_proxy.on("error", (err) => {
            console.log("Proxy server error: " + err)
        })
        this.internal_proxy.on("proxyReq", (proxyReq, req, res, options) => {
            console.log("Proxy request")
        })
    }

    // NOTE Stop the proxy
    public stop() {
        if (this.isOn) {
            this.isOn = false
            console.log("Stopping proxy server with id " + this.proxid)
            this.internal_proxy.close()
            proxyManager._proxies.delete(this.proxid)
        }
    }

    // TODO Add methods to manage a chain of communication as comlink

    // SECTION Static security methods
    // TODO Signing, hashing, etc.
}
