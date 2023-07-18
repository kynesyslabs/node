/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// INFO Identity class for the partecipants

import { cryptography } from "src/libs/crypto"
import { pki } from "node-forge"

interface LoginSignature {
    login_message: string | null
    signature: pki.ed25519.NativeBuffer | null
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
    login_verify(signature: string, pubKey: string): boolean {
        return cryptography.verify(
            this.login_signature.login_message as string,
            signature,
            pubKey,
        )
    }
}
