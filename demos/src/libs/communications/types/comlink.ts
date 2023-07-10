import Transmission from "../transmission"

export interface Current {
    currentMessage: Transmission
    currentMessageHash: string
    previousHashes: string[]
}

export interface Properties {
    require_reply: boolean
    is_reply: boolean
}
