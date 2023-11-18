// INFO This module provides a class to publish informations about the node so that 3rd parties softwares can read them

/* NOTE Usage
	From any other module, just import groundControl and use the getters to set up metric endpoints.
	You can use any variable, but usually sharedState ones are the best ones as they allow other modules
	to publish changes (and, if needed, read them) making them available also for other applications
	through the handy HTTP server.
*/


import * as fs from "fs"
import http from "node:http"
import sharedState from "src/utilities/sharedState"


export default class groundControl {
	static host: string
	static port: number = 10250
	static server: any

	// INFO Literally just initialize the server and its listener
	static async init(port: number = 10250, host: string = "0.0.0.0") {
		groundControl.server = http.createServer(async(req, res) => {
			res.statusCode = 200
			let {url} = req
			// Discarding useless stuff: we are not listening for this kind of requests
			if ( url === "/favicon.ico" ) {
				res.end()
				return
			}
			console.log(url)
			let args = groundControl.parse(url)
			console.log(args)
			let response = await groundControl.dispatch(args)
			res.setHeader("Content-Type", "application/json")
			res.end(JSON.stringify(response))
		})
		groundControl.server.listen(port, host, () => {
			console.log(
				`Ground Control Server is running at http://${host}:${port}/`,
			)
		})
	}

	// INFO Cut my url into pieces
	static parse(args: string): Map<string, any> {
		if (!(args.includes("?") || !(args.includes("/"))) || !(args.includes("="))) {
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
	static async dispatch(args: Map<string, any>): Promise<Object> {
		let response = {
			status: 0,
			message: null,
		}
		// NOTE 'show' endpoint is for metrics
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
		sync_status: function() { return sharedState.getInstance().syncStatus },
	}

}
