
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"
import * as socket_client from "socket.io-client"
import { io } from "socket.io-client"
const  term = require("terminal-kit").terminal

export default class Demos {
    socket: socket_client.Socket

    constructor() {
        this.socket = null
    }
    
    // INFO Connecting to a Demos RPC
    async connect(protocol: string = "http", server: string = "localhost", port: number = 53550): Promise<boolean> {
        this.socket = io(protocol + "://" + server + ":" + port)
        this.setSocket()
        let timer = 0
        if (!this.socket.connected) {
            if (timer < 10000) {
                await sleep(1000)
                timer += 1000
            } else {
                throw new Error("Could not connect to server")
            }
        }
        return this.socket.connected
    }

    // INFO Set listeners for socket events
    setSocket() {
        this.socket.on ("connect", () => {
            console.log ("[Connected]Connected to server")
        })

        this.socket.on("auth_ask", () => {
            console.log("[AuthAsk] Auth ask")
            this.socket.emit("auth_reply", "readonly")
        })

        this.socket.on("auth_ok", () => {
            console.log("[AuthOk] Auth ok")
        })

        this.socket.on("comlink", (data) => {
            console.log("[ComLink] Received data") 
            console.log(data)
            console.log(data.chain.current.currentMessage)
        })

        this.socket.on("comlink_reply", (data) => {
            console.log("[ComLink Reply] Received data") 
            //console.log(data)
            let response = JSON.parse(data.chain.current.currentMessage.bundle.content.message)
            console.log(response)
        })

        this.socket.on("error", (data) => {
            console.log("[Error] Received data") 
            console.log(data)
        })

        // Fallback

        this.socket.onAny((eventName, data) => { 
            console.log("[RECEIVED] " + eventName)
            //console.log (data)	
            //console.log("\n======")
        })
    }


    

    // NOTE Get the last block number easily
    getLastBlockNumber() {
        this.nodeCall("getLastBlockNumber")
    }

    // NOTE Get the last block hash easily
    getLastBlockHash() {
        this.nodeCall("getLastBlockHash")
    }

    // NOTE Get the peer list
    getPeerList() {
        this.nodeCall("getPeerlist")
    }
    
    // NOTE Get a block by its number eily
    getBlockByNumber(num: number) {
        console.log("getBlockByNumber: num = " + num)
        this.nodeCall("getBlockByNumber", {blockNumber: num})
    } 

    // NOTE Get a block by its hash
    getBlockByHash(hash: string) {
        console.log("getBlockByHash called with hash", hash)
        this.nodeCall("getBlockByHash", {hash: hash})
    }

    // NOTE Get the node mempool if authorized
    getMempool() { 
        this.nodeCall("getMempool")
    }

    // INFO NodeCalls use the same structure
    nodeCall(message: string, args: any = {}) {
        if (!this.socket.connected) { console.log("[ERROR] We are disconnected"); return }
        let comlink = new ComLink()
        let transmission = new Transmission()
        transmission.bundle.content.type = "nodeCall"
        transmission.bundle.content.message = message
        transmission.bundle.content.data = args
        comlink.chain.current.currentMessage = transmission
        console.log("Sending message to server with muid: " + comlink.muid)
        this.socket.emit ("comlink", comlink)
    }

}

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}
