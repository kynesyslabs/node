/**
 * Represents a connected peer in the signaling server
 */
export interface ImPeer {
    id: string
    ws: WebSocket
    publicKey: Uint8Array
}



