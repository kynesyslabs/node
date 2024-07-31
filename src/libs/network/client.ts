/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { io } from "socket.io-client"
import terminalkit from "terminal-kit"

import Peer from "../peer/Peer"
import ClientListeners from "./clientListeners"
import CommonListeners from "./commonListeners"
import log from "src/utilities/logger"
const term = terminalkit.terminal

// NOTE Sleep function
async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

export default class Client {

    static async connectToPeerObject(peer: Peer): Promise<[boolean, Peer | null]> {
        // Just a wrapper around the connectToPeer function
        const address = peer.connection.string.split(">")[0]
        const port = parseInt(peer.connection.string.split(">")[1])
        const connectedPeer = await this.connectToPeer(address, port)
        if (!connectedPeer) {
            return [false, null]
        } else {
            return [true, connectedPeer]
        }
    }

    // ! Refactor to accept a Peer object (made with PeerManager.extractPeerFromString)
    static async connectToPeer(
        address: string = "localhost",
        port: number = 53550,
    ): Promise<Peer> {
        address = this.addHttpToUrl(address)
        console.log("[CLIENT] Connecting to peer at " + address + ":" + port)

        let connected = false
        let _peerForged = new Peer()

        const connectionSocket = io(address + ":" + port)
        connectionSocket.on("connect", async () => {
            term.yellow(
                "[CLIENT] Connected to peer at " + address + ":" + port + "\n",
            )
            log.info("[CLIENT] Connecting to peer at " + address + ":" + port)
            _peerForged.identity = "placeholder" // TODO Add identity filling and verification
            _peerForged.connection.socket = connectionSocket
            _peerForged.connection.string = address + ">" + port
            term.yellow("[CLIENT] Connection string set to " + _peerForged.connection.string + "\n")
            const commonListeners = new CommonListeners(_peerForged)
            const clientListeners = new ClientListeners(_peerForged)
            await commonListeners.runListeners()
            await clientListeners.runListeners()
            connected = true
        })

        let timeout = 4000
        //Timeout and timer for the connection (yes, a blocking one)
        while (timeout > 0) {
            if (connected) {
                log.info("[CLIENT] Connected to peer at " + address + ":" + port)
                term.green("[CLIENT] Connected to peer at " + address + ":" + port + "\n")
                return _peerForged
            } else {
                timeout -= 100
                await sleep(100)
            }
        }
        log.error("[CLIENT] Failed to connect to peer at " + address + ":" + port)
        term.red("[CLIENT] Failed to connect to peer at " + address + ":" + port + "\n")
        return null
    }

    static addHttpToUrl(url: string): string {
        if (url.indexOf("http://") === -1 && url.indexOf("https://") === -1) {
            url = "http://" + url
        }
        return url
    }
}
