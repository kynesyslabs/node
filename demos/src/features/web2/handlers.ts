// INFO This module contains all the methods needed to interact with web2 on DEMOS chain
import { Web2Data } from "./web2class"
import { sha256 } from "node-forge"

import axios from "axios"
import axiosRetry from "axios-retry"
import { sendMessageToPeers } from "./peerMessaging"

axiosRetry(axios, {
    retries: 3, // number of retries
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error: any) => {
        // if retry condition is not specified, by default idempotent requests are retried
        return error.response.status === 429
    },
})

// !SECTION Broadcast emitter for web2

// TODO The system will work as following (see classes/web2class.js for more details):
/*
 * Once a web2 data request is received, data.request is filled with the timestamp and status of the request (pending)
 * The node retrieves the data and stores it in data.response with the timestamp and result of the request, then an hash is calculated from the result and stored in data.response.hash
 * The node register himself as data.operator
 * The node choose randomly (or not?) some peers (reputation here?) that will retrieve the data again
 * The peers sends back a response object with their identities, a timestamp and the hash of the retrieved data (that should be equal to data.response.hash)
 * The peers' response contains a signature field that ensure cryptographically that the data was retrieved correctly by that node
 * Once all the hashes correspond, the node sign both data and witnesses and returns the answer that is secure and on chain
 */

const handlers = {
    http_request: http_request,
    // graphql_get: graphql_get,
}

// INFO Provides a method to retrieve a web2 data from a url (simple GET request)
async function http_request(httpVerb: string, url: string, headers: any) {
    console.log("[WEB2] Received http_request")
    if (httpVerb !== "GET" && httpVerb !== "POST") {
        console.log("Wrong http verb")
        return
    }

    let promise: Promise<any>
    const web2Data = new Web2Data()
    web2Data.data.request.timestamp = new Date().getTime()
    // syncData(web2Data, imc.states["web2"])
    // emit_web2_broadcast(web2Data)
    // Fixme: mark as operator??

    switch (httpVerb) {
        case "GET":
            promise = axios.get(url, headers)
            web2Data.status = "pending"
            web2Data.data.request.timestamp = new Date().getTime()
            emit_web2_broadcast({
                action: "attestGetUrl",
                httpVerb: "GET",
                url: url,
                headers: headers,
            })
            break
        case "POST":
            promise = axios.post(url, headers)
            web2Data.status = "pending"
            web2Data.data.request.timestamp = new Date().getTime()
            await emit_web2_broadcast(web2Data)
            break
        default:
            console.log("Wrong http verb")
            return
    }

    try {
        const response = await promise
        web2Data.status = "retrieved"
        web2Data.data.response.timestamp = new Date().getTime()
        web2Data.data.response.result = response.data

        let md = sha256.create()
        md.update(JSON.stringify(response.data))
        web2Data.data.response.hash = md.digest().toHex()

        //syncData(web2Data, imc.states["web2"])
        await emit_web2_broadcast(web2Data)
    } catch (error) {
        console.error(error)
        web2Data.status = "error"
        web2Data.data.response.timestamp = new Date().getTime()
        //syncData(web2Data, imc.states["web2"])
        await emit_web2_broadcast(web2Data)
        throw error
    }
}

async function emit_web2_broadcast(data: any) {
    await sendMessageToPeers(data)
}

export default handlers
