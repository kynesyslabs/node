import forge from "node-forge"

// NOTE
// In case of POST requests, the data is the only parameter thus 'name' is ignored
// In case of GET requests, we can have multiple parameters, thus 'name' is used to identify them
export interface IParam {
    name: string // Ignored in POST requests
    value: any
}

// INFO Properties of a typical request as the client would send it
// NOTE This should be the thing we receive from the handler as a request
// NOTE Basically is the comlink message
export interface IWeb2Payload {
    type: "web2Request"
    message: IWeb2Request
    sender: any
    receiver: any
    timestamp: any
    data: any
    extra: any
}

// INFO A web2 result interface
export interface IWeb2Result {
    status: number
    statusText: string
    data: any
}

// INFO A complete web2 request
export interface IWeb2Request {
    raw: IRawWeb2Request
    result: any
    attestations: {}
    hash: string
    signature?: forge.pki.ed25519.BinaryBuffer
}

// INFO A request without any attestations or identity data
export interface IRawWeb2Request {
    action: string
    parameters: IParam[]
    requestedParameters: [] | null
    method: "POST" | "GET" | "PUT" | "DELETE" | "PATCH"
    url: string
    headers: any
    minAttestations: number
    // Handling the various stages of an IWeb2Request
    stage: {
        // The one that will handle the response too
        origin: {
            identity: forge.pki.ed25519.BinaryBuffer
            connection_url: string
        }
        // Starting from 0, each attestation it is increased
        hop_number: number
    }
}

// ANCHOR Useful interfaces
export interface IWeb2Attestation {
    hash: string
    timestamp: number
    identity: forge.pki.PublicKey
    signature: forge.pki.ed25519.BinaryBuffer
    valid: boolean
}
