// INFO This module contains all the methods needed to interact with web2 on DEMOS chain
var Web2Data = require("classes/web2class.js")
const https = require("https")
const fetch = require("node-fetch")

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
    https_get: https_get,
    api_get: api_get,
}

// INFO Provides a method to retrieve a web2 data from a url (simple GET request)
async function https_get(url) {
    https.get(url, response => {
        let data = ""
        response.on("data", chunk => {
            data += chunk
        })
        response.on("end", () => {
            // Create and fill a web2 data object and return it
            let web2Data = new Web2Data(data)
            // TODO Fill it
            return web2Data
        })
        response.on("error", error => {
            // TODO Handle the errors
            console.log(error)
        })
    })
}

// INFO Provides a method to retrieve a web2 data from JSON api (GET)
async function api_get(url) {
    // Given an url, try to GET a JSON response
    try {
        let response = await fetch(url)
        let data = await response.json()
        // Create and fill a web2 data object and return it
        let web2Data = new Web2Data(data)
        // TODO Fill it
        return web2Data
    } catch (error) {
        // TODO Handle the errors
        console.log(error)
    }
}

module.exports = { methods }
