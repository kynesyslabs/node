import axios from "axios"
import terminalkit from "terminal-kit"

// INFO This module is used to retrieve a resource from a raw request
import { IParam, IRawWeb2Request, IWeb2Result } from "../../types/Web2Types"

const term = terminalkit.terminal

// INFO Experimental a new approach to requests
export default async function post(
    raw_request: IRawWeb2Request,
): Promise<IWeb2Result> {
    // TODO Next line is for debug purposes
    raw_request.headers = {}

    term.green("[Web2Parser] Retrieving data from raw request...\n")
    //console.log(raw_request)
    let { url } = raw_request
    // Url normalization
    if (url.includes("?")) {
        url = url.split("?")[0]
    }
    // For POSTs we need exactly one parameter, the data
    let params: IParam[] = raw_request.parameters
    if (params.length !== 1) {
        term.red.bold(
            "[Web2Parser] Error retrieving resource: " +
                "POST requests must have exactly one parameter, the data\n",
        )
        return {
            status: 400,
            statusText: "Bad Request",
            data: "POST requests must have exactly one parameter, the data",
        }
    }
    // Sanitizing the data so that it can be sent as a POST request
    let data = params[0].value
    // REVIEW This is a very basic check, we should probably do more
    // For example, should we check that the data is a valid JSON? Theoretically, no
    // as the data could be anything, but we could check that it is not empty
    if (data === "") {
        term.red.bold(
            "[Web2Parser] Error retrieving resource: " +
                "POST requests must have a valid JSON data parameter\n",
        )
        return {
            status: 400,
            statusText: "Bad Request",
            data: "POST requests must have a valid JSON data parameter",
        }
    }
    // NOTE We should have a normalized url, so we can make the request
    term.yellow.bold("[Web2Parser] Retrieving derived url: " + url + "\n")
    let payload = {
        headers: raw_request.headers, //FIXME on budino
        url: url,
        data: data,
    }
    // NOTE Now we should have a normalized url, so we can make the request
    let response: any
    try {
        response = await axios.post(payload.url, payload.data, {
            headers: payload.headers,
        })
    } catch (error) {
        console.log(error)
        term.red.bold("[Web2Parser] Error retrieving resource: " + error + "\n")
        response = { status: 500, statusText: "Axios Error", data: error }
        return response
    }
    term.yellow("[Web2Parser] Posted to: " + payload.url + "\n")
    let data_response = response.data
    term.bold("[Web2Parser] Data response:\n")
    //console.log(data_result)
    let sanitizedResult = {
        status: response.status,
        statusText: response.statusText,
        data: data_response,
    }
    term.yellow.bold("\nResult to validate obtained\n")
    //console.log(sanitizedResult)
    // Web2Parser will then validate the result
    return sanitizedResult
}
