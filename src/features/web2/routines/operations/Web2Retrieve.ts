import axios from "axios"
import terminalKit from "terminal-kit"

import { IParam, IRawWeb2Request, IWeb2Result } from "@kynesyslabs/demosdk-http/types"

const term = terminalKit.terminal

/**
 * Retrieves a resource from a raw request.
 * The URL is derived from the rawRequest object.
 * The headers for the request are extracted from the rawRequest.
 * If parameters are present in the rawRequest, they are added to the URL.
 * 
 * @param {IRawWeb2Request} rawRequest - The raw request object containing the URL, headers, and parameters for the request.
 * @returns {Promise<IWeb2Result>} - Returns a promise that resolves to the result of the request.
 * 
 * @throws Will throw an error if the request fails.
 */
export default async function retrieve(
    rawRequest: IRawWeb2Request,
): Promise<IWeb2Result> {
    // TODO Next line is for debug purposes
    rawRequest.headers = {}

    term.green("[Web2Parser] Retrieving resource from raw request...\n")
    //console.log(rawRequest)
    const params: IParam[] = rawRequest.parameters
    let { url } = rawRequest
    // Url normalization
    if (url.includes("?")) {
        url = url.split("?")[0]
    }
    // If we have parameters, add them to the request
    if (params.length > 1) {
        // 1 is due to the fact that theoretically we should have at least the url
        const paramString = params
            .map(param => param.name + "=" + param.value)
            .join("&")
        url += "?" + paramString
    }
    // NOTE We should have a normalized url, so we can make the request
    term.yellow.bold("[Web2Parser] Retrieving derived url: " + url + "\n")
    const payload = {
        headers: rawRequest.headers, //FIXME on budino
        // NOTE The following line selectively sets the body to null if the method is not POST
        // and look for the "data" parameter in the parameters array if the method is POST
        // TODO Handle the case where the method is POST but no "data" parameter is present
        url: url,
    }
    // NOTE Now we should have a normalized url, so we can make the request
    let fetched: any
    try {
        fetched = await axios.get(payload.url, 
            { 
                headers: payload.headers, 
                timeout: 10000,
            })

    } catch (error) {
        console.log(error)
        term.red.bold("[Web2Parser] Error retrieving resource: " + error + "\n")
        fetched = { status: 500, statusText: "Axios Error", data: error }
        return fetched
    }
    term.yellow("[Web2Parser] Retrieved: " + payload.url + "\n")
    const result = fetched.data
    term.bold("[Web2Parser] Data result:\n")
    //console.log(result)
    const sanitizedResult = {
        status: fetched.status,
        statusText: fetched.statusText,
        data: result,
    }
    term.yellow.bold("\nResult to validate obtained\n")
    //console.log(sanitizedResult)
    // Web2Parser will then validate the result
    return sanitizedResult
}
