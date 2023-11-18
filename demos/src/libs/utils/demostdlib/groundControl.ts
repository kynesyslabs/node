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
import required, { requiredOutcome } from "src/utilities/required"
import sharedState from "src/utilities/sharedState"

export default class groundControl {
    static host: string
    static port: number = 10250
    static server: any

    static options = {
        key: null,
        cert: null,
        ca: null,
    }

    // INFO Literally just initialize the server and its listener
    static async init(
        port: number = 10250,
        host: string = "0.0.0.0",
        protocol: "http" | "https" = "http",
        keys: any,
    ): Promise<any> {
        // HTTPS Check
        if (protocol === "https") {
            let protocolOutcome: requiredOutcome = null
            let errorFlag: boolean = false
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
                groundControl.options = {
                    key: fs.readFileSync(keys.key),
                    cert: fs.readFileSync(keys.cert),
                    ca: fs.readFileSync(keys.ca),
                }
                groundControl.server = https.createServer(
                    groundControl.options,
                    groundControl.HandlerMethod,
                )
				} catch (e) {
					// Also here, we fallback happily
                    console.log(e)
                    console.log("[groundControl] [ Failure ] Failed to start HTTPS server. Switching to HTTP")
					protocol = "http"
                }
            }
        }
        // Supporting fallback
        if (protocol === "http") {
            groundControl.server = http.createServer(
                groundControl.HandlerMethod,
            )
        }
        groundControl.server.listen(port, host, () => {
            console.log(
                "Ground Control Server is running at" +
                    protocol +
                    "://" +
                    host +
                    ":" +
                    port,
            )
        })
    }

    // INFO This is the handler for the server
    static async HandlerMethod(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ) {
        res.statusCode = 200
        let { url } = req
        // Discarding useless stuff: we are not listening for this kind of requests
        if (url === "/favicon.ico") {
            res.end()
            return
        }
        console.log(url)
        let args = groundControl.parse(url)
        console.log(args)
        let response = await groundControl.dispatch(args)
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
        let cleanArgs = args.split("?")[1]
        let argsArray = cleanArgs.split("&")
        let argsObject = new Map<string, any>()
        // Parsing arguments and keys and creating a proper object
        for (let i = 0; i < argsArray.length; i++) {
            let arg = argsArray[i]
            let key = arg.split("=")[0]
            let value = arg.split("=")[1]
            argsObject.set(key, value)
        }
        return argsObject
    }

    // INFO This is groundControl to variable Tom
    static async dispatch(args: Map<string, any> = null): Promise<Object> {
        let response = {
            status: 0,
            message: null,
        }
        // NOTE 'show' endpoint is for metrics
        if (!args) {
            response.message = "This is not the page you are looking for."
            response.status = 404
            return response
        }
        if (args.has("show")) {
            let metric: any
            let status: number
            switch (args.get("show")) {
                // Are we sync or not?
                case "sync":
                    metric = groundControl.get.sync_status().toString()
                    status = 200
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
        sync_status: function () {
            return sharedState.getInstance().syncStatus
        },
    }
}
