import ComLink from "./comlink"
import { ResponseRegistryElement, Response } from "./types/responseregistry"
import Transmission from "./transmission"
import { Socket } from "socket.io"

async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

export default class ResponseRegistry {
    list: { [key: string]: ResponseRegistryElement }

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
                identity: null
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
    registerResponse(message: Transmission, comlink_muid: string, socket: Socket) {
        if (!this.list[comlink_muid])
            return [false, "No response has been requested"]
        this.list[comlink_muid].response.timestamp = Date.now()
        this.list[comlink_muid].response.socket = socket
        this.list[comlink_muid].response.identity = message.bundle.content.sender
        this.list[comlink_muid].response.message = message.bundle.content.message
        return [true, this.list[comlink_muid]]
    }

    // INFO Check with the muid if a response has been received and return a promise
     async checkResponse(muid: string): Promise<[boolean,Response]> {
            let timeout = 0
            while (!this.list[muid].response.message) {
                await sleep(100)
                timeout += 100
                if (timeout > 2000) return [false, this.list[muid].response]
            }
            return [true, this.list[muid].response]
    }
}
