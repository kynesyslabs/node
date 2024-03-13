/* eslint-disable no-unused-vars */
import { Server as HttpServer } from "http"
import { Server as IOServer, Socket as ServerSocket } from "socket.io"
import { io as IOClient, Socket as ClientSocket } from "socket.io-client"

class Server {
    private server: HttpServer
    private io: IOServer

    constructor() {
        this.server = new HttpServer()
        this.io = new IOServer(this.server)
    }

    start(port: number) {
        this.server.listen(port, () => {
            console.log(`Server started on port ${port}`)
            this.listeners()
            console.log("Listeners listening")
        })
    }

    // INFO Setting up server listeners
    private listeners() {
        this.io.on("connection", (socket: ServerSocket) => {
            console.log("[SERVER] New connection")
            socket.on("message", (message: string) => {
                let response: any = { status: 200, message: null, extra: null }
                console.log("[SERVER] Received message: ", message)
                switch (message) {
                    case "Heart":
                        console.log("[SERVER] Heartbeat")
                        response.message = "Beat"
                        break
                    default:
                        console.log("[SERVER] Unknown message: ", message)
                        response.status = 404
                        response.message = "Unknown message"
                        response.extra = "ERROR"
                        break
                }

                response = JSON.stringify(response)
                socket.emit(response)
            })
        })
    }
}

class Client {
    private socket: ClientSocket

    constructor() {}

    async connect(url: string) {
        this.socket = IOClient(url)
        let waitingPromise = new Promise((resolve, reject) => {
            this.socket.on("connect", () => {
                console.log("[CLIENT] Connected to server")
                this.listeners()
                this.socket.send("Heart")
                resolve(true)
            })
            this.socket.on("connect_error", error => {
                console.log("[CLIENT] Connection error", error)
                reject(error)
            })
            this.socket.on("connect_timeout", timeout => {
                console.log("[CLIENT] Connection timeout", timeout)
                reject(timeout)
            })
            this.socket.on("error", error => {
                console.log("[CLIENT] Error", error)
                reject(error)
            })
        })
        return waitingPromise
    }

    private listeners() {
        this.socket.on("Beat", (message: string) => {
            console.log("[CLIENT] Received message: ", message)
            switch (message) {
                case "Beat":
                    console.log("[CLIENT] Heartbeat")
                    break
                default:
                    console.log("[CLIENT] Unknown message: ", message)
                    break
            }
        })
    }
}

class Wrapper {
    private server: Server
    private client: Client

    constructor() {
        this.server = new Server()
        this.client = new Client()
    }

    async test(port: number = 8080, url: string = "http://localhost") {
        console.log("[Server Test] Starting")
        this.server.start(port)
        console.log("[Server Test] Server started")
        console.log("[Client Test] Starting")
        let success = await this.client.connect(url + ":" + port)
        console.log(
            "[Client Test] Client server communication success: " + success,
        )
        return success
    }
}

async function main() {
    const smooth = new Wrapper()
    let ready = await smooth.test()
    if (ready) {
        console.log("[SmoothOperator] Ready")
    } else {
        console.log("[SmoothOperator] Not ready")
    }
}

main()
