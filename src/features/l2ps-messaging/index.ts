/**
 * L2PS Messaging Feature
 *
 * Real-time instant messaging backed by L2PS rollup.
 * Messages are delivered via WebSocket and persisted through
 * the L2PS batch → proof → L1 pipeline.
 */

export { L2PSMessagingServer } from "./L2PSMessagingServer"
export { L2PSMessagingService } from "./L2PSMessagingService"
export { L2PSMessage } from "./entities/L2PSMessage"
export { computeMessageHash, encryptMessage, decryptMessage, generateSymmetricKey } from "./crypto"
export type * from "./types"

import { L2PSMessagingServer } from "./L2PSMessagingServer"

let server: L2PSMessagingServer | null = null

export function startL2PSMessaging(port: number): L2PSMessagingServer {
    if (server) return server
    server = new L2PSMessagingServer(port)
    return server
}

export function stopL2PSMessaging(): void {
    if (server) {
        server.stop()
        server = null
    }
}

export function isL2PSMessagingEnabled(): boolean {
    return process.env.L2PS_MESSAGING_ENABLED?.toLowerCase() === "true"
}
