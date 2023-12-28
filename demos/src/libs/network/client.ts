/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { io } from "socket.io-client"
import Peer from "../peer/Peer"
import CommonListeners from "./commonListeners"
import ClientListeners from "./clientListeners"

import terminalkit from "terminal-kit"
var term = terminalkit.terminal

// NOTE Sleep function
async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

export default class Client {
    static async connectToPeer(
        address: string = "localhost",
        port: number = 53550,
    ) {
        address = this.addHttpToUrl(address)
        console.log("[CLIENT] Connecting to peer at " + address + ":" + port)

        let connected = false
        let _peerForged = new Peer()

        const connectionSocket = io(address + ":" + port)
        connectionSocket.on("connect", async () => {
            term.green(
                "[CLIENT] Connected to peer at " + address + ":" + port + "\n",
            )
            _peerForged.identity = "placeholder" // TODO Add identity filling and verification
            _peerForged.socket = connectionSocket
            _peerForged.connectionString = address + ">" + port
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
                return _peerForged
            } else {
                timeout -= 100
                await sleep(100)
            }
        }
        return null
    }

    static addHttpToUrl(url: string): string {
        if (url.indexOf("http://") === -1 && url.indexOf("https://") === -1) {
            url = "http://" + url
        }
        return url
    }
}
