// INFO This module provides a class to publish informations about the node so that 3rd parties softwares can read them

/* NOTE Usage
	From any other module, just import groundControl and use the getters to set up metric endpoints.
	You can use any variable, but usually sharedState ones are the best ones as they allow other modules
	to publish changes (and, if needed, read them) making them available also for other applications
	through the handy HTTP server.
*/

import * as fs from "fs"
import http from "node:http"
import https from "node:https"
import { PeerManager } from "src/libs/peer"
import required, { RequiredOutcome } from "src/utilities/required"
import { getSharedState } from "src/utilities/sharedState"

export default class GroundControl {
    static host: string
    static port = 10250
    static server: any

    static options = {
        key: null,
        cert: null,
        ca: null,
    }

    // INFO Literally just initialize the server and its listener
    static async init(
        port = 10250,
        host = "0.0.0.0",
        protocol: "http" | "https" = "http",
        keys: any,
    ): Promise<any> {
        // HTTPS Check
        if (protocol === "https") {
            let protocolOutcome: RequiredOutcome = null
            let errorFlag = false
            // We want to check one by one if the keys are present and valid before starting the server
            protocolOutcome = required(
                keys,
                "[groundControl] [ Failure ] Missing keys",
                false,
            )
            if (!protocolOutcome.success) errorFlag = true
            protocolOutcome = required(
                keys.cert,
                "[groundControl] [ Failure ] Missing certificate",
                false,
            )
            if (!protocolOutcome.success) errorFlag = true
            protocolOutcome = required(
                keys.key,
                "[groundControl] [ Failure ] Missing key",
                false,
            )
            if (!protocolOutcome.success) errorFlag = true
            protocolOutcome = required(
                keys.ca,
                "[groundControl] [ Failure ] Missing CA",
                false,
            )
            if (!protocolOutcome.success) errorFlag = true

            if (errorFlag) {
                // Instead of failing, we switch to HTTP in case of failure
                protocol = "http"
                console.log("[groundControl] [ Failure ] Switching to HTTP")
            } else {
                // Else we can start da server
                try {
                    GroundControl.options = {
                        key: fs.readFileSync(keys.key),
                        cert: fs.readFileSync(keys.cert),
                        ca: fs.readFileSync(keys.ca),
                    }
                    GroundControl.server = https.createServer(
                        GroundControl.options,
                        GroundControl.handlerMethod,
                    )
                } catch (e) {
                    // Also here, we fallback happily
                    console.log(e)
                    console.log(
                        "[groundControl] [ Failure ] Failed to start HTTPS server. Switching to HTTP",
                    )
                    protocol = "http"
                }
            }
        }
        // Supporting fallback
        if (protocol === "http") {
            GroundControl.server = http.createServer(
                GroundControl.handlerMethod,
            )
        }
        GroundControl.server.listen(port, host, () => {
            console.log(
                "Ground Control Server is running at " +
                    protocol +
                    "://" +
                    host +
                    ":" +
                    port,
            )
        })
    }

    // INFO This is the handler for the server
    static async handlerMethod(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ) {
        res.statusCode = 200
        const { url } = req
        // Discarding useless stuff: we are not listening for this kind of requests
        if (url === "/favicon.ico") {
            res.end()
            return
        }
        console.log(url)
        const args = GroundControl.parse(url)
        //console.log(args)
        const response = await GroundControl.dispatch(args)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(response))
    }

    // INFO Cut my url into pieces
    static parse(args: string): Map<string, any> {
        if (
            !(args.includes("?") || !args.includes("/")) ||
            !args.includes("=")
        ) {
            return null
        }
        // Separate arguments
        const cleanArgs = args.split("?")[1]
        const argsArray = cleanArgs.split("&")
        const argsObject = new Map<string, any>()
        // Parsing arguments and keys and creating a proper object
        for (let i = 0; i < argsArray.length; i++) {
            const arg = argsArray[i]
            const key = arg.split("=")[0]
            const value = arg.split("=")[1]
            argsObject.set(key, value)
        }
        return argsObject
    }

    // INFO This is groundControl to variable Tom
    static async dispatch(args: Map<string, any> = null): Promise<Object> {
        const response = {
            status: 0,
            message: null,
        }
        // NOTE 'show' endpoint is for metrics
        if (!args) {
            response.message = "Bad Request"
            response.status = 400
            return response
        }
        if (args.has("show")) {
            let metric: any
            let status: number
            switch (args.get("show")) {
                // Are we sync or not?
                case "sync":
                    metric = GroundControl.get.syncStatus().toString()
                    status = 200
                    break
                case "connected_peers":
                    metric = GroundControl.get.connectedPeers().toString()
                    status = 200
                    break
                case "mempool_size":
                    // TODO in mempool
                    break
                // TODO: implement more metrics
                default:
                    metric = "No data available for this metric"
                    break
            }
            // Returning retrieved data
            response.message = metric
            response.status = status
        }
        return response
    }

    /* SECTION Data retrieverz */

    static get = {
        syncStatus: function () {
            return getSharedState.syncStatus
        },
        connectedPeers: function () {
            const plist = PeerManager.getInstance().getAll()
            return plist.length
        },
    }
}
