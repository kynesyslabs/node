import axios from "axios"
import terminalkit from "terminal-kit"

// INFO This module is used to retrieve a resource from a raw request
import { IParam, IRawWeb2Request, IWeb2Result } from "../../types/Web2Types"

const term = terminalkit.terminal

// INFO Experimental a new approach to requests
export default async function retrieve(
    raw_request: IRawWeb2Request,
): Promise<IWeb2Result> {
    // TODO Next line is for debug purposes
    raw_request.headers = {}

    term.green("[Web2Parser] Retrieving resource from raw request...\n")
    //console.log(raw_request)
    let params: IParam[] = raw_request.parameters
    let { url } = raw_request
    // Url normalization
    if (url.includes("?")) {
        url = url.split("?")[0]
    }
    /* 
        if (!(url.endsWith("/"))) {
            url += "/"
        } */
    // If we have parameters, add them to the request
    if (params.length > 1) {
        // 1 is due to the fact that theoretically we should have at least the url
        let param_string = params
            .map(param => param.name + "=" + param.value)
            .join("&")
        url += "?" + param_string
    }
    // NOTE We should have a normalized url, so we can make the request
    term.yellow.bold("[Web2Parser] Retrieving derived url: " + url + "\n")
    let payload = {
        headers: raw_request.headers, //FIXME on budino
        // NOTE The following line selectively sets the body to null if the method is not POST
        // and look for the "data" parameter in the parameters array if the method is POST
        // TODO Handle the case where the method is POST but no "data" parameter is present
        url: url,
    }
    // NOTE Now we should have a normalized url, so we can make the request
    let fetched: any
    try {
        fetched = await axios.get(payload.url, { headers: payload.headers })
    } catch (error) {
        console.log(error)
        term.red.bold("[Web2Parser] Error retrieving resource: " + error + "\n")
        fetched = { status: 500, statusText: "Axios Error", data: error }
        return fetched
    }
    term.yellow("[Web2Parser] Retrieved: " + payload.url + "\n")
    let data_result = fetched.data
    term.bold("[Web2Parser] Data result:\n")
    //console.log(data_result)
    let sanitizedResult = {
        status: fetched.status,
        statusText: fetched.statusText,
        data: data_result,
    }
    term.yellow.bold("\nResult to validate obtained\n")
    //console.log(sanitizedResult)
    // Web2Parser will then validate the result
    return sanitizedResult
}
