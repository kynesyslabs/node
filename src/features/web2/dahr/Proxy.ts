import https from "https"
import httpProxy from "http-proxy"
import required from "src/utilities/required"
import terminalKit from "terminal-kit"

import {
    IWeb2Request,
} from "@kynesyslabs/demosdk/types"

import { EnumWeb2Methods } from "node_modules/@kynesyslabs/demosdk/build/types/web2"
import { DAHR } from "./DAHR"

const term = terminalKit.terminal

export class Proxy {
  /**
   * The proxy server used to forward HTTP requests.
   * @type {httpProxy}
   */
  private proxyServer: httpProxy

  /**
   * Creates a new instance of the Proxy class.
   *
   * @param {string} source - The source address that the proxy server will listen on.
   * @param {string} target - The target address that the proxy server will forward requests to.
   * @param {DAHR} dahr - An instance of the DAHR class. This parameter is required.
   * @throws {Error} Will throw an error if the `dahr` parameter is not provided.
   */
  constructor(source: string, private target: string, private dahr: DAHR) {
      required(this.dahr, "Missing DAHR instance")
      this.proxyServer = httpProxy.createProxyServer({target: this.target})

      https.createServer((req, res) => {
          this.proxyServer.web(req, res)
      }).listen(source)
  }

  /**
   * Send a request.
   * @param {IWeb2Request["raw"] | null} body - The potential request body.
   * @param {string} path - The path.
   * @param {string} method - The HTTP method that the proxy should call.
   * @returns {Promise<any>, IWeb2Request} An object with the web2 response and requests.
   */
  send(
      body: IWeb2Request["raw"] | null, 
      path: string, 
      method: EnumWeb2Methods = EnumWeb2Methods.GET,
      // TODO Need to type web2Result somehow
  ): Promise<any> {
          // TODO Will need to take into consideration the case where the method is "GET" on the first hop.
          if (!body && !(method === "GET")) {
              term.yellow.bold(
                  "[Web2API] No raw request attached. Is this right?",
              )
              // TODO Specify this as a parameter that users can set
              this.dahr.web2Request.raw.minAttestations = 10
              this.dahr.web2Request.raw.stage.hopNumber = 0
          } else {
            this.dahr.web2Request.raw = body
          }

          return new Promise((resolve, reject) => {
              const options = {
                  hostname: this.target,
                  port: 80,
                  path: path,
                  method: method,
                  headers: {
                      "Content-Type": "application/json",
                      "Content-Length": Buffer.byteLength(JSON.stringify(body)),
                  },
              }

              const req = https.request(options, (res) => {
                  res.setEncoding("utf8")
                  let rawData = ""
                  res.on("data", (chunk) => { rawData += chunk })
                  res.on("end", () => {
                      resolve(JSON.parse(rawData))
                  })
              })

              req.on("error", (error) => {
                  reject(error)
              })

              if (method === "POST" || 
                  method === "PUT" ||
                  method === "PATCH" || 
                  method === "DELETE") {
                  req.write(JSON.stringify(body))
              }

              req.end()
          })
  }

  /**
   * Stop the proxy server.
   */
  stop() {
      console.log("Stopping proxy server with target " + this.target)
      this.proxyServer.close()
  }
}