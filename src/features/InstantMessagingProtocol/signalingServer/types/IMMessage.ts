import type { SerializedSignedObject } from "@kynesyslabs/demosdk/types"

export function clientIdFromSigningKey(publicKey: Uint8Array): string {
    return `0x${Buffer.from(publicKey).toString("hex")}`
}

/** Exact bytes signed for one connection's registration. */
export function registrationProofBytes(
    clientId: string,
    publicKey: Uint8Array,
    challenge: string,
): Uint8Array {
    return new TextEncoder().encode(
        JSON.stringify(["im-register-v1", clientId, Array.from(publicKey), challenge]),
    )
}

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
