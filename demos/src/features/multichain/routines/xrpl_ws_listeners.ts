import * as WebSocket from "ws"
let socket: WebSocket
const awaiting = {}

// INFO Setting up basic listeners
export default async function xrplWSListeners(receiving_socket: WebSocket) {
	socket = receiving_socket
    // INFO Listening for generic open events
    socket.addEventListener("open", (event: any) => {
        // This callback runs when the connection is open
        console.log("[XRPL_WS] Connected!")
        const command = {
            id: "on_open_ping_1",
            command: "ping",
        }
        socket.send(JSON.stringify(command))
    })
    // INFO Listening for messages
    socket.addEventListener("message", (event: { data: any }) => {
        console.log("[XRPL_WS] Got message from server:", event.data)
    })
    // INFO Listening for generic close events
    socket.addEventListener("close", (event: any) => {
        // Use this event to detect when you have become disconnected
        // and respond appropriately.
        console.log("[XRPL_WS] Disconnected...")
    })
}
