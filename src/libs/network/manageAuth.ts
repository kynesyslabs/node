import Cryptography from "../crypto/cryptography"
import * as forge from "node-forge"
import terminalkit from "terminal-kit"
import log from "src/utilities/logger"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { Peer, PeerManager } from "../peer"

const term = terminalkit.terminal

export type AuthMessage = [string, forge.pki.ed25519.NativeBuffer, forge.pki.ed25519.BinaryBuffer]

export async function manageAuth(data: any): Promise<RPCResponse> {
    // REVIEW Auth reply listener should not add a client to the peerlist if is read only
    let identity = await Cryptography.load("./.demos_identity")
    term.yellow("[SERVER] Received auth reply")
    // Unpack the data for readability
    if (data !== "readonly") {
        let auth_message = data as AuthMessage
        term.yellow("[SERVER] Received auth reply: verifying")
        log.info("Received auth reply: verifying")
        let original_message = auth_message[0] as string
        let original_signature = auth_message[1] as forge.pki.ed25519.NativeBuffer
        let original_identity = auth_message[2] as forge.pki.ed25519.BinaryBuffer
        let _verification = Cryptography.verify(
            original_message, // The message that our peer should have signed
            original_signature, // The signature of the auth message as defined in commonListeners.ts
            original_identity, // The identity of the peer as a public key
        )
        // Disconnect if the verification is false
        if (!_verification) {
            return {
                result: 401,
                response: "Unauthorized",
                require_reply: false,
                extra: "verification failed",
            }
        }
        // Getting the public IP of the peer so we can add it to the peerlist
        let remote_ip = original_message.split(":")[0].trim()
        let connection_string = remote_ip + ">53550>" + original_identity // ! Allow dynamic ports
        // ? REVIEW build the Peer object and add it to the peerlist (connection string missing atm)
        let new_peer: Peer = new Peer()
        new_peer.identity = original_identity
        new_peer.connection.string = connection_string
        // Setting the verification status to true
        new_peer.verification.status = true
        new_peer.verification.message = original_message
        new_peer.verification.timestamp = new Date().getTime()
        PeerManager.getInstance().addPeer(new_peer)
        log.info("Peer added to the peerlist: " + connection_string)
    } else {
        term.yellow(
            "[SERVER] Client is read only: not asking for authentication",
        )
    }
    // And we reply ok with our signature too
    let _signature = Cryptography.sign("auth_ok", identity.privateKey)
    return {
        result: 200,
        response: "OK",
        require_reply: false,
        extra: "auth_ok",
    }
}
