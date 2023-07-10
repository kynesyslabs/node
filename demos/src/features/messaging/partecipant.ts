// INFO Identity class for the partecipants

import { cryptography } from "src/libs/crypto"

interface LoginSignature {
    login_message: string | null
    signature: string | null
}

export class Partecipant {
    address: string
    route: string
    login_signature: LoginSignature

    constructor(address: string, route: string) {
        this.address = address // Public key of the participant
        this.route = route // last known URL of the participant
        this.login_signature = {
            login_message: null,
            signature: null,
        } // By verifying this, we can infer logged in or out status
    }

    // INFO Testing if the route is still valid
    check_route(): void {
        // TODO Connect to test
    }

    // INFO Generating a login challenge that the client must sign
    login_challenge(): void {
        let timestamp = Date.now()
        this.login_signature.login_message =
            "Logging " + this.address + " @ " + timestamp
    }

    // INFO Verifying a login message against the challenge
    login_verify(signature: string, pubKey: string): Promise<boolean> {
        return cryptography.verify(
            this.login_signature.login_message as string,
            signature,
            pubKey,
        )
    }
}
