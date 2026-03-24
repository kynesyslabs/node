import Cryptography from "../crypto/cryptography"
import * as forge from "node-forge"
import log from "src/utilities/logger"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { Peer, PeerManager } from "../peer"

export type AuthMessage = [
    string,
    forge.pki.ed25519.NativeBuffer,
    forge.pki.ed25519.BinaryBuffer,
]

export async function manageAuth(data: any): Promise<RPCResponse> {
    // REVIEW Auth reply listener should not add a client to the peerlist if is read only
    const identity = await Cryptography.load("./.demos_identity")
    log.info("SERVER", "Received auth reply")
    // Unpack the data for readability
    if (data !== "readonly") {
        const authMessage = data as AuthMessage
        log.info("SERVER", "Received auth reply: verifying")
        const originalMessage = authMessage[0] as string
        const originalSignature =
            authMessage[1] as forge.pki.ed25519.NativeBuffer
        const originalIdentity =
            authMessage[2] as forge.pki.ed25519.BinaryBuffer
        const verification = Cryptography.verify(
            originalMessage, // The message that our peer should have signed
            originalSignature, // The signature of the auth message as defined in commonListeners.ts
            originalIdentity, // The identity of the peer as a public key
        )
        // Disconnect if the verification is false
        if (!verification) {
            return {
                result: 401,
                response: "Unauthorized",
                require_reply: false,
                extra: "verification failed",
            }
        }
        // Getting the public IP of the peer so we can add it to the peerlist
        const remoteIp = originalMessage.split(":")[0].trim()
        const connectionString = remoteIp + ":53550" // ! Allow dynamic ports
        // ? REVIEW build the Peer object and add it to the peerlist (connection string missing atm)
        const newPeer: Peer = new Peer()
        newPeer.identity = originalIdentity.toString("hex")
        newPeer.connection.string = connectionString
        // Setting the verification status to true
        newPeer.verification.status = true
        newPeer.verification.message = originalMessage
        newPeer.verification.timestamp = new Date().getTime()
        PeerManager.getInstance().addPeer(newPeer)
        log.info("Peer added to the peerlist: " + connectionString)
    } else {
        log.info("SERVER", "Client is read only: not asking for authentication")
    }
    // And we reply ok with our signature too
    const signature = Cryptography.sign("auth_ok", identity.privateKey as any)
    return {
        result: 200,
        response: "OK",
        require_reply: false,
        extra: "auth_ok",
    }
}
