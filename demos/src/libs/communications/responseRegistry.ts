/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import ComLink from "./comlink"
import { ResponseRegistryElement, Response } from "./types/responseregistry"
import Transmission from "./transmission"
import { Socket } from "socket.io"
import * as socket_client from "socket.io-client"
import * as Security from "../network/securityModule"
import Datasource from "src/model/datasource"
import { ResponseRegistry as ResponseRegistryModel } from "src/model/entities/ResponseRegistry"

const term = require("terminal-kit").terminal

async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

// REVIEW INFO DB API To the ResponseRegistry
export class ResponseRegistryDB {
    private static instance: ResponseRegistryDB

    public static getInstance(): ResponseRegistryDB {
        if (!ResponseRegistryDB.instance) {
            ResponseRegistryDB.instance = new ResponseRegistryDB()
        }
        return ResponseRegistryDB.instance
    }

    // REVIEW INFO Preparing a responseRegistry entry for a response
    static async requestResponse(comlink: ComLink): Promise<any> {
        // Sanity check
        if (!comlink.properties.require_reply) {
            return [
                false,
                "ComLink object must have required_reply property set to true",
            ]
        }

        const db = await Datasource.getInstance()
        const responseRegistryRepository = db
            .getDataSource()
            .getRepository(ResponseRegistryModel)

        // Checking if the response request is already in the registry
        const responseRegistry = await responseRegistryRepository.find({
            where: {
                muid: comlink.muid,
            },
        })
        if (responseRegistry.length > 0) {
            return [false, "Response request already in registry"]
        }
        // Adding the response request to the registry
        let empty_response: Response = {
            message: null,
            timestamp: null,
            socket: null,
            identity: null,
            connection_string: null,
        }

        let newResponseRegistry = responseRegistryRepository.create({
            muid: comlink.muid,
            timestamp: Date.now(),
            response: JSON.stringify(empty_response),
            comlink: JSON.stringify(comlink),
        })
        return [true, newResponseRegistry]
    }

    static async hasResponse(comlink: ComLink) {
        const db = await Datasource.getInstance()
        const responseRegistryRepository = db
            .getDataSource()
            .getRepository(ResponseRegistryModel)

        const responseRegistryQuery = await responseRegistryRepository.findOne({
            where: { muid: comlink.muid },
        })

        if (!responseRegistryQuery) {
            return [false, "No response request in registry"]
        }

        let { response } = responseRegistryQuery
        if (!response) {
            return [false, "No response has been received"]
        }

        return [true, response]
    }

    // REVIEW INFO Register a response received

    static async registerResponse(
        message: Transmission,
        comlink_muid: string,
        socket: Socket | socket_client.Socket,
    ) {
        const db = await Datasource.getInstance()
        const responseRegistryRepository = db
            .getDataSource()
            .getRepository(ResponseRegistryModel)

        try {
            const responseRegistryResult =
                await responseRegistryRepository.findOne({
                    where: { muid: comlink_muid },
                })

            if (!responseRegistryResult) {
                return [false, "No response request in registry"]
            }

            // Updating the response object
            let response = responseRegistryResult.response || ({} as any)
            response.timestamp = Date.now()
            response.socket = socket
            response.identity = message.bundle.content.sender
            response.message = message.bundle.content.message

            // Saving the updated response
            responseRegistryResult.response = response
            const updatedResponseRegistry =
                await responseRegistryRepository.save(responseRegistryResult)

            return [true, updatedResponseRegistry]
        } catch (e) {
            console.error("Error registering response:", e)
        }
    }

    // REVIEW INFO Check with the muid if a response has been received and return a promise
    async checkResponse(
        muid: string,
    ): Promise<[boolean, ResponseRegistryModel["response"]]> {
        let timeout = 0
        const db = await Datasource.getInstance()
        const responseRegistryRepository = db
            .getDataSource()
            .getRepository(ResponseRegistryModel)

        let responseRegistryQuery = await responseRegistryRepository.findOne({
            where: { muid: muid },
        })

        while (!responseRegistryQuery) {
            await new Promise(resolve => setTimeout(resolve, 100))
            timeout += 100
            if (timeout > 2000) {
                return [false, null]
            }

            responseRegistryQuery = await responseRegistryRepository.findOne({
                where: { muid: muid },
            })
        }

        return [true, responseRegistryQuery.response]
    }
}

// NOTE This is a legacy, memory based implementation of the response registry.
export default class ResponseRegistry {
    list: { [key: string]: ResponseRegistryElement }
    database: any
    lastFlagged: number

    // The instance of ResponseRegistry
    private static instance: ResponseRegistry

    private constructor() {
        this.list = {}
        this.lastFlagged = new Date().getTime()
    }

    // Method to get the instance of ResponseRegistry

    static getInstance() {
        if (!ResponseRegistry.instance) {
            ResponseRegistry.instance = new ResponseRegistry()
        }

        return ResponseRegistry.instance
    }
    // INFO Register a response request
    requestResponse(comlink: ComLink) {
        // sourcery skip: use-braces
        if (!comlink.properties.require_reply)
            return [
                false,
                "ComLink object must have required_reply property set to true",
            ]
        if (this.list[comlink.muid])
            return [false, "Response has already been requested"]
        this.list[comlink.muid] = {
            comlink: comlink,
            timestamp: Date.now(),
            response: {
                message: null,
                timestamp: null, // Set to now once received
                socket: null,
                identity: null,
                connection_string: null,
            },
        }
        console.log("[CREATED RESPONSE REQUEST]")
        console.log(this.list[comlink.muid])
        return [true, this.list[comlink.muid]]
    }

    // TODO Do it in db from now on
    // INFO Check if a response has been received
    hasResponse(comlink: ComLink) {
        if (!this.list[comlink.muid]) {
            return [false, "No response has been requested"]
        }
        if (!this.list[comlink.muid].response) {
            return [false, "No response has been received"]
        }
        return [true, this.list[comlink.muid].response]
    }

    // INFO Register a response received

    registerResponse(
        message: Transmission,
        comlink_muid: string,
        socket: Socket | socket_client.Socket,
        connection_string: string,
    ) {
        if (!this.list[comlink_muid]) {
            return [false, "No response has been requested"]
        }
        this.list[comlink_muid].response.timestamp = Date.now()
        this.list[comlink_muid].response.socket = socket
        this.list[comlink_muid].response.identity =
            message.bundle.content.sender
        this.list[comlink_muid].response.message =
            message.bundle.content.message
        this.list[comlink_muid].response.connection_string = connection_string
        return [true, this.list[comlink_muid]]
    }

    flag() {
        console.log("[ResponseRegistry] [GARBAGE_FLAGGER] Pruning started...")
        // Getting flag time from the sharedState
        let flagTime =
            Security.modules.communications.response_registry.flag_hardlimit
        let total = Object.keys(this.list).length
        let counter = 0
        let now = new Date().getTime()
        let item: string | number
        for (item in this.list) {
            //console.log(this.list[item])
            if (!this.list[item]) {
                continue // Garbage collector kindly managed it for us
            }
            // TODO Greatly improve this simple method
            // At the moment, after X milliseconds the responses are closed
            let delta = now - this.list[item].timestamp
            if (delta >= flagTime) {
                // Deleting expired sessions
                console.log(
                    "[ResponseRegistry] [GARBAGE_FLAGGER] Flagged: " + item,
                )
                this.list[item] = undefined
                counter += 1
            }
        }
        this.lastFlagged = now
        console.log("[ResponseRegistry] [GARBAGE_FLAGGER] Pruning Report:")
        console.log("[Items] " + total.toString())
        console.log("[Flagged] " + counter.toString())
    }

    // FIXME Fundamental: implement autopruning
    deleteResponse(comlink_muid: string | number) {
        if (this.list[comlink_muid]) {
            this.list[comlink_muid] = undefined
        }
    }

    // INFO Check with the muid if a response has been received and return a promise
    async checkResponse(muid: string): Promise<[boolean, Response]> {
        let timeout = 0
        console.log("Logging MUID: " + muid)
        term.yellow.bold.bgBlue(
            "Response Registry length: " + Object.keys(this.list).length + "\n",
        )
        // REVIEW Pruning automatically
        let pruningMode = true // TODO Debug line
        if (pruningMode) {
            console.log(
                "[ResponseRegistry] [getInstance] Pre-flight pruning...",
            )
            let now = new Date().getTime()
            console.log(
                "[ResponseRegistry] [GARBAGE_FLAGGER] Now: " + now.toString(),
            )
            let delta = now - ResponseRegistry.instance.lastFlagged
            console.log(
                "[ResponseRegistry] [GARBAGE_FLAGGER] Last Flagged: " +
                    ResponseRegistry.instance.lastFlagged.toString(),
            )
            console.log(
                "[ResponseRegistry] [GARBAGE_FLAGGER] Delta: " +
                    delta.toString(),
            )
            if (
                delta >
                Security.modules.communications.response_registry.flag_interval
            ) {
                console.log(
                    "[ResponseRegistry] [GARBAGE_FLAGGER] Time to flag!",
                )
                ResponseRegistry.instance.flag()
            } else {
                console.log(
                    "[ResponseRegistry] [GARBAGE_FLAGGER] No need to flag!",
                )
            }
        }
        console.log("[ResponseRegistry] Instance retrieved")

        while (!this.list[muid].response.message) {
            await sleep(100)
            timeout += 100
            if (timeout > 2000) {
                return [false, this.list[muid].response]
            }
        }
        console.log(
            "[RESPONSES] " +
                this.list[muid].response.connection_string +
                " replied to " +
                muid,
        )
        return [true, this.list[muid].response]
    }
}
