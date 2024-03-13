// INFO Module to manage authentication sessions for DEMOS WebAuthentication
/* NOTE
    This module is NOT intended to be used for simple signatures authentication (that can be done client
    side). It is intended to be used to have the DEMOS Chain as a trustless authentication system in the
    context of applications that usually rely on SSOs and similar.
*/

import Cryptography from "src/libs/crypto/cryptography"

import { normalizeWebBuffers } from "./normalizeWebBuffers"

const SESSION_TIMEOUT = 1000 * 60 * 5 // 5 minutes

function randomMessage() {
    let result = ""
    const characters =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    const charactersLength = characters.length
    let counter = 0
    while (counter < 32) {
        result += characters.charAt(
            Math.floor(Math.random() * charactersLength),
        )
        counter += 1
    }
    return result
}

export interface ISession {
    start_timestamp: number
    last_timestamp: number
    end_timestamp: number
    current_status: boolean
    current_stage: string
    session_message: string
    session_signature: string
    session_token: string
}

export default class Sessions {
    private static _instance: Sessions

    registry: Map<string, ISession> // Where string is an address

    public static getInstance(): Sessions {
        if (!Sessions._instance) {
            Sessions._instance = new Sessions()
        }
        return Sessions._instance
    }

    constructor() {
        this.registry = new Map<string, ISession>()
    }

    // INFO Getting a session from the registry
    public getSession(address: string): ISession {
        return this.registry.get(address)
    }

    // INFO Checking if a session is still valid
    public isSessionValid(address: string): boolean {
        let session = this.registry.get(address)
        // If no session has been opened yet, return false
        if (!session || !session.current_status) {
            return false
        }
        // Checking the timestamps
        if (session.last_timestamp + SESSION_TIMEOUT < Date.now()) {
            // Or should we use start_timestamp?
            return false
        }
    }

    // INFO Generating a new session
    public newSession(address: string): ISession {
        // Generate a new session
        let session: ISession = {
            start_timestamp: Date.now(),
            last_timestamp: Date.now(),
            end_timestamp: Date.now() + SESSION_TIMEOUT,
            current_status: false,
            current_stage: "waiting for signature",
            session_message: randomMessage(),
            session_signature: null,
            session_token: null,
        }
        this.registry.set(address, session)
        return this.registry.get(address)
    }

    // INFO Validating a signature and openning a session
    // NOTE We need either a JSON string, a JSON object ({type: "Buffer", data: []}) or a Uint8Array
    public validateSignature(s_address: string, s_signature: string): boolean {
        let session = this.registry.get(s_address)
        // If no session has been opened yet, return false
        if (!session || !session.current_status) {
            return false
        }
        // Normalizing the signature and the address
        let message = this.registry.get(s_address).session_message
        let res_signature = normalizeWebBuffers(s_signature)
        if (!res_signature[0]) {
            return false
        }
        let signature = res_signature[0]
        let res_address = normalizeWebBuffers(s_address)
        if (!res_address[0]) {
            return false
        }
        let address = res_address[0]
        // Validating the signature
        let valid = Cryptography.verify(message, signature, address)
        return valid
    }

    // TODO Send back, checks, security and so on
}
