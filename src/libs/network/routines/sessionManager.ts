// INFO Module to manage authentication sessions for DEMOS WebAuthentication
/* NOTE
    This module is NOT intended to be used for simple signatures authentication (that can be done client
    side). It is intended to be used to have the DEMOS Chain as a trustless authentication system in the
    context of applications that usually rely on SSOs and similar.
*/

import Cryptography from "src/libs/crypto/cryptography"

import { normalizeWebBuffers } from "./normalizeWebBuffers"

const sessionTimeout = 1000 * 60 * 5 // 5 minutes

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

export interface InterfaceSession {
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

    registry: Map<string, InterfaceSession> // Where string is an address

    public static getInstance(): Sessions {
        if (!Sessions._instance) {
            Sessions._instance = new Sessions()
        }
        return Sessions._instance
    }

    constructor() {
        this.registry = new Map<string, InterfaceSession>()
    }

    // INFO Getting a session from the registry
    public getSession(address: string): InterfaceSession {
        return this.registry.get(address)
    }

    // INFO Checking if a session is still valid
    public isSessionValid(address: string): boolean {
        const session = this.registry.get(address)
        // If no session has been opened yet, return false
        if (!session || !session.current_status) {
            return false
        }
        // Checking the timestamps
        if (session.last_timestamp + sessionTimeout < Date.now()) {
            // Or should we use start_timestamp?
            return false
        }
    }

    // INFO Generating a new session
    public newSession(address: string): InterfaceSession {
        // Generate a new session
        const session: InterfaceSession = {
            start_timestamp: Date.now(),
            last_timestamp: Date.now(),
            end_timestamp: Date.now() + sessionTimeout,
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
    public validateSignature(
        sessionAddress: string,
        sessionSignature: string,
    ): boolean {
        const session = this.registry.get(sessionAddress)
        // If no session has been opened yet, return false
        if (!session || !session.current_status) {
            return false
        }
        // Normalizing the signature and the address
        const message = this.registry.get(sessionAddress).session_message
        const resSignature = normalizeWebBuffers(sessionSignature)
        if (!resSignature[0]) {
            return false
        }
        const signature = resSignature[0]
        const resAddress = normalizeWebBuffers(sessionAddress)
        if (!resAddress[0]) {
            return false
        }
        const address = resAddress[0]
        // Validating the signature
        const valid = Cryptography.verify(message, signature, address)
        return valid
    }

    // TODO Send back, checks, security and so on
}
