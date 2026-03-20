/**
 * Petri Consensus — ContinuousForge singleton instance.
 *
 * Shared between the forge loop (which starts it) and the RPC handler
 * (which queries it for current deltas during delta exchange).
 */

import { ContinuousForge } from "./continuousForge"

/**
 * The global ContinuousForge instance.
 * Set by petriConsensusRoutine() when the forge starts.
 * Read by the petri_exchangeDeltas RPC handler.
 */
export let petriForgeInstance: ContinuousForge | null = null

export function setPetriForgeInstance(instance: ContinuousForge | null): void {
    petriForgeInstance = instance
}

export function getPetriForgeInstance(): ContinuousForge | null {
    return petriForgeInstance
}
