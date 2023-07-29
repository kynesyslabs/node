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
            console.log(data.chain.current.currentMessage.bundle.content.message)
        })

        // Fallback

        this.socket.onAny((eventName, data) => { // FIXME Why the server keeps trying to sync with a non identity based client?
            console.log("[RECEIVED] " + eventName)
            //console.log (data)	
            //console.log("\n======")
        })
    }


    // INFO Get the last block number easily
    getLastBlockNumber() {
        if (!this.socket.connected) { console.log("[ERROR] We are disconnected"); return }
        let comlink = new ComLink()
        let transmission = new Transmission()
        transmission.bundle.content.type = "nodeCall"
        transmission.bundle.content.message = "getLastBlockNumber"
        comlink.chain.current.currentMessage = transmission
        console.log("Sending message to server with muid: " + comlink.muid)
        this.socket.emit ("comlink", comlink)
    }

}

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}
