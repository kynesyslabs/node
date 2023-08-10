/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// !SECTION Broadcast emitter for web2

// TODO The system will work as following (see classes/web2class.js for more details):
/*
 * Once a web2 data request is received, data.request is filled with the timestamp and status of the request (pending)
 * The node retrieves the data and stores it in data.response with the timestamp and result of the request, then an hash is calculated from the result and stored in data.response.hash
 * The node register himself as data.operator
 * The node requests attestation of the data from peers that will retrieve the data again and sign it using their private key, while adding themselves to the attestator list in the web2 data object
 * The peers sends back a response object with their identities, a timestamp and the hash of the retrieved data (that should be equal to data.response.hash)
 * The peers' response contains a signature field that ensure cryptographically that the data was retrieved correctly by that node
 * Once all the hashes correspond, the node sign both data and witnesses and returns the answer that is secure and on chain
 */

// INFO This module contains all the methods needed to interact with web2 on DEMOS chain
import { Web2Data } from "src/features/web2"
import { sha256 } from "node-forge"
import web2registry from "src/features/web2/web2registry"
import axios from "axios"
import axiosRetry from "axios-retry"
import { sendMessageToPeers } from "./peerMessaging"
import { Peer } from "src/libs/peer"
import { Identity } from "src/libs/identity"

const id = Identity.getInstance()

axiosRetry(axios, {
    retries: 3, // number of retries
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error: any) => {
        // if retry condition is not specified, by default idempotent requests are retried
        return error.response.status === 429
    },
})

const web2RegistryInstance = web2registry.getInstance()

const handlers = {
    http_request: http_request,
    http_attest: http_attest,
    http_process_attestation: http_process_attestation,
    // graphql_get: graphql_get,
}

// INFO Provides a method to retrieve a web2 data from a url (simple GET request)
async function http_request(
    httpVerb: string,
    url: string,
    headers: any,
    currentPeerString: string,
    peerCount: number,
) {
    console.log("[WEB2] Received http_request")
    if (httpVerb !== "GET" && httpVerb !== "POST") {
        console.log("Wrong http verb")
        return
    }

    const web2Data = new Web2Data()

    let promise: Promise<any>

    const peer = new Peer()
    peer.setConnectionString(currentPeerString)
    web2Data.data.operator = peer
    web2Data.peer_count = peerCount
    web2Data.data.request.timestamp = new Date().getTime()
    web2Data.data.request.url = url

    web2RegistryInstance.addEntry(web2Data) //TODO - Not sure this is even needed.
    // This was intended to be used to store the state so that it cant get manipulated by the peer,
    // but we should probably just use the web2Data object directly and not store it in the registry

    switch (httpVerb) {
        case "GET":
            promise = axios.get(url, headers)
            web2Data.status = "pending"
            web2Data.data.request.timestamp = new Date().getTime()
            await emit_web2_broadcast({
                action: "attestGetUrl",
                httpVerb: "GET",
                url: url,
                headers: headers,
                web2Data: web2Data,
            })
            break
        case "POST":
            promise = axios.post(url, headers)
            web2Data.status = "pending"
            web2Data.data.request.timestamp = new Date().getTime()
            await emit_web2_broadcast({
                action: "attestPostUrl",
                httpVerb: "POST",
                url: url,
                headers: headers,
                web2Data: web2Data,
            })
            break
        default:
            console.log("Wrong http verb")
            return
    }

    try {
        const response = await promise
        web2Data.status = "retrieved"
        web2Data.data.response.timestamp = new Date().getTime()
        web2Data.data.response.result = response.data //TODO - consider extracting data via a mapping function with some selector?
        web2Data.signData(id.ed25519.privateKey as any) //TODO - improve types for keys

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

async function http_attest(
    httpVerb: string,
    url: string,
    headers: any,
    currentPeerString: string,
    web2DataObject?: Web2Data,
) {
    console.log("[WEB2] Received http_attest request")
    if (httpVerb !== "GET" && httpVerb !== "POST") {
        console.log("Wrong http verb")
        return
    }

    if (!web2DataObject) {
        console.log("Missing Web2Data state")
        return
    }

    const web2Data = new Web2Data(web2DataObject)

    const peer = new Peer()
    peer.setConnectionString(currentPeerString)

    let promise: Promise<any>

    switch (httpVerb) {
        case "GET":
            promise = axios.get(url, headers)
            //TODO - consider adding a timeout?
            break
        case "POST":
            promise = axios.post(url, headers)
            //TODO - consider adding a timeout?
            break
        default:
            console.log("Wrong http verb")
            return
    }

    try {
        const response = await promise

        const timestamp = new Date().getTime()
        const data = response.data //TODO - consider extracting data via a mapping function with some selector?
        console.log("Retrieved data from " + url + " at " + timestamp)

        console.log(Object.keys(web2Data))

        web2Data.addWitness(
            id.ed25519.publicKey,
            id.ed25519.privateKey,
            peer,
            data,
            timestamp,
        )
        console.log("Added witness to web2Data")
        await emit_web2_broadcast({
            action: "process_attestGetUrl",
            httpVerb: "GET",
            url: url,
            headers: headers,
            web2Data: web2Data,
        })
    } catch (error) {
        console.error(error)
        // We should probably not send data back to the original peer now, right?
        // squelch the error for now

        // web2Data.status = "error"
        // web2Data.data.response.timestamp = new Date().getTime()
        // await emit_web2_broadcast(web2Data)
        // throw error
    }
}

async function http_process_attestation(
    httpVerb: string,
    url: string,
    headers: any,
    currentPeerString: string,
    web2DataObject?: Web2Data,
) {
    console.log("[WEB2] Received http_process_attestation request")
    if (httpVerb !== "GET" && httpVerb !== "POST") {
        console.log("Wrong http verb")
        return
    }

    if (!web2DataObject) {
        console.log("Missing Web2Data state")
        return
    }

    const web2Data = new Web2Data(web2DataObject)

    const peer = new Peer()
    peer.setConnectionString(currentPeerString)

    try {
        // check for witness validity. We start by comparing the hashes from the witnesses with the hash from the data

        const dataHash = web2Data.data.response.hash

        const validWitnesses = {}

        // store the valid witnesses in the validWitness object by their public key

        for (const [key, value] of Object.entries(web2Data.witnesses)) {
            const witnessHash = value.response.hash
            if (witnessHash === dataHash) {
                validWitnesses[key] = value
            }
        }

        // check if we have enough valid witnesses
        const sufficientValidWitnesses =
            Object.keys(web2Data.witnesses).length >= web2Data.peer_count / 3 // + 1 // This should satisfy BFT

        if (!sufficientValidWitnesses) {
            console.log("Not enough valid witnesses")
            return
        }

        web2Data.signWitnesses(id.ed25519.privateKey as any)

        // We should now have a fully formed and valid web2Data object

        console.log(
            "Web2Data object is valid and witnesses have successfully attested it",
        )
    } catch (error) {
        console.error(error)
        // We should probably not send data back to the original peer now, right?
        // squelch the error for now

        // web2Data.status = "error"
        // web2Data.data.response.timestamp = new Date().getTime()
        // await emit_web2_broadcast(web2Data)
        // throw error
    }
}

async function emit_web2_broadcast(data: any) {
    await sendMessageToPeers(data)
}

export default handlers
