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
import Datasource from "src/model/datasource"

async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

// INFO Singleton API to the chain registry db
// REVIEW Should work properly but who knows
// FIXME Reorder fields in the table and check what is not working (in Sync.ts?)
export class ResponseRegistry_db {
    private static instance: ResponseRegistry

    static async read(sql_query: string) {
        try {
            const db = await Datasource.getInstance()
            const result = await db.getDataSource().query(sql_query)

            //console.log("[ChainDB] [ READ ]: ")
            //console.log(result)
            return result
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            throw err
        }
    }

    static async write(sql_query: string) {
        try {
            const db = await Datasource.getInstance()
            const result = await db.getDataSource().query(sql_query)
            //console.log("[ChainDB] [ WRITE ]: " + result)
            return result
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            throw err
        }
    }

    // Response registry methods

    static async requestResponse(comlink: ComLink) {
        if (!comlink.properties.require_reply)
            return [
                false,
                "ComLink object must have required_reply property set to true",
            ]
        // TODO Insert method to look for existance
        let response_entry = {
            comlink: comlink,
            timestamp: Date.now(),
            response: {
                message: null,
                timestamp: null, // Set to now once received
                socket: null,
                identity: null,
            },
        }
        // REVIEW Write into the registry
        await this.write(
            "INSERT INTO responseRegistry (muid, comlink, timestamp, response) VALUES ('" +
                comlink.muid +
                "', '" +
                comlink.muid +
                "', " +
                response_entry.timestamp +
                ", '" +
                JSON.stringify(response_entry.response) +
                "')",
        )

        // INFO Check if a response has been received
    }

    static async hasResponse(
        comlink: ComLink = null,
        specify_muid: number = null,
    ) /* TODO Typize response */ {
        let muid: number | string
        try {
            if (specify_muid) muid = specify_muid
            else muid = comlink.muid
        } catch (err) {
            return [false, "Unexpected response received"]
        }

        let rows = await this.read(
            "SELECT * FROM responseRegistry WHERE muid ='" + muid + "'",
        )
        if (rows.length == 0) return [false, "No response expected"]
        else {
            // TODO Extract the response
            console.log(rows)
        }
    }

    // INFO Register a response received

    static async registerResponse(
        message: Transmission,
        comlink_muid: string,
        socket: Socket,
    ) {
        let rows = await this.read(
            "SELECT * FROM responseRegistry WHERE muid = '" +
                comlink_muid +
                "'",
        )
        if (rows.length == 0) return [false, "No response expected"]
        console.log(rows)
        let resp: Response = rows[0]
        resp.timestamp = rows[0].timestamp
        resp.socket = rows[0].socket
        resp.identity = message.bundle.content.sender
        resp.message = message.bundle.content.message
        // Updating the object in the table
        await this.write(
            "UPDATE responseRegistry SET response = '" +
                JSON.stringify(resp) +
                "' WHERE muid = '" +
                comlink_muid +
                "'",
        )
        return [true, resp]
    }

    // INFO Check with the muid if a response has been received and return a promise
    static async checkResponse(muid: string): Promise<[boolean, Response]> {
        let timeout = 0
        let has_response: any = null
        while (!has_response) {
            has_response = await this.hasResponse(null, parseInt(muid))
            if (!has_response[0]) has_response = null
            await sleep(100)
            timeout += 100
            if (timeout > 2000) return [false, has_response]
        }
        return [true, has_response]
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
            },
        }
        return [true, this.list[comlink.muid]]
    }

    // INFO Check if a response has been received
    hasResponse(comlink: ComLink) {
        if (!this.list[comlink.muid])
            return [false, "No response has been requested"]
        if (!this.list[comlink.muid].response)
            return [false, "No response has been received"]
        return [true, this.list[comlink.muid].response]
    }

    // INFO Register a response received
    // TODO Do it in db

    registerResponse(
        message: Transmission,
        comlink_muid: string,
        socket: Socket | socket_client.Socket,
    ) {
        if (!this.list[comlink_muid])
            return [false, "No response has been requested"]
        this.list[comlink_muid].response.timestamp = Date.now()
        this.list[comlink_muid].response.socket = socket
        this.list[comlink_muid].response.identity =
            message.bundle.content.sender
        this.list[comlink_muid].response.message =
            message.bundle.content.message
        return [true, this.list[comlink_muid]]
    }

    // INFO Check with the muid if a response has been received and return a promise
    async checkResponse(muid: string): Promise<[boolean, Response]> {
        let timeout = 0
        while (!this.list[muid].response.message) {
            await sleep(100)
            timeout += 100
            if (timeout > 2000) return [false, this.list[muid].response]
        }
        return [true, this.list[muid].response]
    }
}
