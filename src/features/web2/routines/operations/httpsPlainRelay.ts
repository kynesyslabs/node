import https from "https"

export interface IHTTPSOptions {
    hostname: string
    port: number
    path: string
    method: string
    headers: {
        "Content-Type": string
        "Content-Length": number
    }
}

// Relay a https request to the server taking care of handling the options passed
// NOTE Data is received either through HTTP or HTTPS, anyway using this method the server
// is able to read the HTTPS data from the client
export function httpsPlainRelay(options: IHTTPSOptions, data: any) {
    var postdata = JSON.stringify(data)
    options.headers["Content-Length"] = Buffer.byteLength(postdata)
    var req = https.request(options, function (res) {
        res.setEncoding("utf8")
        res.on("data", function (chunk) {
            console.log("Response: " + chunk)
        })
    })
    req.write(postdata)
    req.end()
}