import { SerializedSignedObject } from "@kynesyslabs/demosdk/types"

export interface ImBaseMessage {
    type: string
    payload: any
}

export interface ImRegisterMessage extends ImBaseMessage {
    type: "register"
    payload: {
        clientId: string
        publicKey: Uint8Array
        verification: SerializedSignedObject
    }
}

export interface ImDiscoverMessage extends ImBaseMessage {
    type: "discover"
    payload: {}
}


export interface ImPeerMessage extends ImBaseMessage {
    type: "message"
    payload: {
        targetId: string
        message: string
    }
}

export interface ImPublicKeyRequestMessage extends ImBaseMessage {
    type: "request_public_key"
    payload: {
        targetId: string
    }
}
