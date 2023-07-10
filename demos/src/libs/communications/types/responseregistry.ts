import ComLink from "../comlink"
import { Transmission } from "../transmission"

export interface Response {
    message: Transmission // TODO Add message type
    timestamp: number
}

export interface ResponseRegistryElement {
    comlink: ComLink
    timestamp: number
    response: Response
}
