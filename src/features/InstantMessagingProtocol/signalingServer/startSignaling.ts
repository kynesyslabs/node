import log from "src/utilities/logger"
import type { SignalingServer } from "./signalingServer"

export type SignalingStart =
    | { status: "ready"; server: SignalingServer }
    | { status: "skipped" }
    | { status: "failed"; error: Error }

/**
 * Starts the signaling server when enabled. A failure is returned, not
 * thrown: instant messaging is an optional service and a busy port must not
 * take a validator off the network.
 */
export function startSignaling(
    enabled: boolean,
    port: number,
    create: (port: number) => SignalingServer,
): SignalingStart {
    if (!enabled) {
        log.info("[NETWORK] Signaling server disabled (SIGNALING_ENABLED=false)")
        return { status: "skipped" }
    }
    try {
        const server = create(port)
        log.info(`[NETWORK] Signaling server started on port ${port}`)
        return { status: "ready", server }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        log.error(
            `[NETWORK] Signaling server failed to start on port ${port}: ${err.message}. ` +
                "The node runs on without instant messaging signaling.",
        )
        return { status: "failed", error: err }
    }
}
