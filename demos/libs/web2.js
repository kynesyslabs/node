// INFO This module contains all the methods needed to interact with web2 on DEMOS chain
var Web2Data = require("classes/web2class.js")

const sha256 = require("sha256")

var air = require("./air.js")
var imc = new air()
imc.initialize("web2")

const axios = require("axios")
const axiosRetry = require("axios-retry")

axiosRetry(axios, {
    retries: 3, // number of retries
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: error => {
        // if retry condition is not specified, by default idempotent requests are retried
        return error.response.status === 429
    },
})

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

var methods = {
    http_request: http_request,
    // graphql_get: graphql_get,
}

// INFO Provides a method to retrieve a web2 data from a url (simple GET request)
async function http_request(httpVerb, url, headers) {
    if (httpVerb !== "GET" && httpVerb !== "POST") {
        console.log("Wrong http verb")
        return
    }

    var promise
    const web2Data = new Web2Data()
    web2Data.data.request.timestamp = new Date().getTime()
    syncData(web2Data, imc["web2"])

    switch (httpVerb) {
        case "GET":
            promise = axios.get(url, headers)
            web2Data.status = "pending"
            web2Data.data.request.timestamp = new Date().getTime()
            syncData(web2Data, imc["web2"])
            break
        case "POST":
            promise = axios.post(url, headers)
            web2Data.status = "pending"
            web2Data.data.request.timestamp = new Date().getTime()
            syncData(web2Data, imc["web2"])
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
        web2Data.data.response.hash = sha256(JSON.stringify(response.data))
        syncData(web2Data, imc["web2"])
    } catch (error) {
        console.error(error)
        web2Data.status = "error"
        web2Data.data.response.timestamp = new Date().getTime()
        syncData(web2Data, imc["web2"])
        throw error
    }
}

function syncData(web2Data, imcObj) {
    imcObj.status = web2Data.status
    imcObj.data.request.timestamp = web2Data.data.request.timestamp
    imcObj.data.request.timestamp = web2Data.data.request.timestamp
    imcObj.data.response.timestamp = web2Data.data.response.timestamp
    imcObj.data.response.result = web2Data.data.response.result
    imcObj.data.response.hash = web2Data.data.response.hash
    // Add here for other properties you want to sync
}

module.exports = { methods }
