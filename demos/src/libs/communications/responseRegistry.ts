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
import Chain from "../blockchain/chain"

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
        // Checking if the response request is already in the registry
        var responseRegistry_query = await Chain.read(
            "SELECT * from responseRegistry where muid = '" +
                comlink.muid +
                "'",
        )
        if (responseRegistry_query.length > 0) {
            return [false, "Response request already in registry"]
        }
        // Adding the response request to the registry
        let empty_response: Response = {
            message: null,
            timestamp: null, // Set to now once received
            socket: null,
            identity: null,
            connection_string: null,
        }

        let responseRegistry_write = await Chain.write(
            "INSERT INTO responseRegistry (muid, timestamp, response, comlink) VALUES ('" +
                comlink.muid +
                "', '" +
                Date.now() +
                "', '" +
                JSON.stringify(empty_response) +
                "', '" +
                JSON.stringify(comlink) +
                "')",
        )
        return [true, responseRegistry_write]
    }

    // REVIEW INFO Check if a response has been received
    static async hasResponse(comlink: ComLink) {
        var responseRegistry_query = await Chain.read(
            "SELECT * from responseRegistry where muid = '" +
                comlink.muid +
                "'",
        )
        // Leaving out the unrequested responses
        if (responseRegistry_query.length < 1) {
            return [false, "No response request in registry"]
        }
        // Inspect the response
        let {response} = responseRegistry_query[0]
        if (!response) {
          return [false, "No response has been received"]
        }
        // We have a response
        return [true, response]
    }

    // REVIEW INFO Register a response received

    static async registerResponse(
        message: Transmission,
        comlink_muid: string,
        socket: Socket | socket_client.Socket,
    ) {
        var responseRegistry_query = await Chain.read(
            "SELECT * from responseRegistry where muid = '" +
                comlink_muid +
                "'",
        )
        // Leaving out the unrequested responses
        if (responseRegistry_query.length < 1) {
            return [false, "No response request in registry"]
        }
        let responseElement = responseRegistry_query[0]
        let {response} = responseElement
        response.timestamp = Date.now()
        response.socket = socket
        response.identity = message.bundle.content.sender
        response.message = message.bundle.content.message
        // Writing the response
        var responseRegistry_write = await Chain.write(
            "UPDATE (response) SET response = '" +
                JSON.stringify(response) +
                "' WHERE muid = '" +
                comlink_muid +
                "'",
        )
        return [true, responseRegistry_write]
    }

    // REVIEW INFO Check with the muid if a response has been received and return a promise
    async checkResponse(muid: string): Promise<[boolean, Response]> {
        let timeout = 0
        var responseRegistry_query = await Chain.read(
            "SELECT * from responseRegistry where muid = '" + muid + "'",
        )
        while (responseRegistry_query.length < 1) {
            await sleep(100)
            timeout += 100
            if (timeout > 2000) {
              return [false, null]
            }
            responseRegistry_query = await Chain.read(
                "SELECT * from responseRegistry where muid = '" + muid + "'",
            )
        }
        return [true, responseRegistry_query[0].response]
    }
}

// NOTE This is a legacy, memory based implementation of the response registry.
export default class ResponseRegistry {
    list: { [key: string]: ResponseRegistryElement }
    database: any

    // The instance of ResponseRegistry
    private static instance: ResponseRegistry

    private constructor() {
        this.list = {}
    }

    // Method to get the instance of ResponseRegistry
    static getInstance(): ResponseRegistry {
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

    // FIXME Fundamental: implement autopruning
    deleteResponse(comlink_muid) {
        if (this.list[comlink_muid]) {
            this.list[comlink_muid] = undefined
        }
    }

    // INFO Check with the muid if a response has been received and return a promise
    async checkResponse(muid: string): Promise<[boolean, Response]> {
        let timeout = 0
        console.log("Logging MUID: " + muid)
        console.log(this.list)
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
