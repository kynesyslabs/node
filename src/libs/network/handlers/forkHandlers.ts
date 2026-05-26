import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "@/forks/forkGates"
import log from "@/utilities/logger"
import { NODE_VERSION, type NodeVersionInfo } from "@/utilities/nodeVersion"
import type { NodeCallHandler } from "./types"

// REVIEW: P3c — fork-status RPC. Adds `getNetworkInfo` so SDK v3 (P4) can
// detect whether to serialize `amount` as DEM-number (pre-fork) or
// OS-string (post-fork) without a second round-trip.

/**
 * Per-fork status entry surfaced by `getNetworkInfo`.
 *
 * @property activationHeight Configured activation height for the fork, or
 *   `null` if the fork is configured but unscheduled. Mirrors
 *   `SharedState.forkConfig[forkName].activationHeight`.
 * @property activated Whether the fork's rules are currently active —
 *   computed via the canonical {@link isForkActive} gate so this matches the
 *   serializer/validator code paths exactly.
 * @property currentHeight In-memory cache of the latest block height the
 *   node has processed (`SharedState.lastBlockNumber`). Lets clients do
 *   their own near-fork detection without an extra `getLastBlockNumber`
 *   call.
 */
export interface ForkStatus {
    activationHeight: number | null
    activated: boolean
    currentHeight: number
}

/**
 * Response shape for `getNetworkInfo`.
 *
 * Wrapped in `forks.<name>` so that adding a future fork is a strictly
 * additive change rather than a breaking one.
 *
 * `nodeVersion` is the build-time provenance of the responding node
 * (package version, git SHA, branch, dirty flag, build timestamp).
 * Surfacing it on the same call operators already poll for fork status
 * means a single round-trip can answer both "is the fork active?" and
 * "is this node running the binary I think it is?" — the second
 * question is what we want when chasing "fix merged to stabilisation
 * but symptom still reproduces" cases. Optional in the response so
 * older SDKs that destructure `forks` keep working.
 */
export interface NetworkInfo {
    forks: {
        osDenomination: ForkStatus
    }
    nodeVersion: NodeVersionInfo
}

/**
 * Reads the current block height from in-memory shared state. Wrapped in a
 * helper so tests can replace it without poking at module internals.
 *
 * Uses `SharedState.lastBlockNumber` rather than `Chain.getLastBlockNumber()`
 * to keep this RPC cheap (no DB round-trip). The shared-state field is
 * updated by `chainBlocks.insertBlock` and on startup, so it tracks the
 * persisted tip closely enough for fork-detection use.
 */
function readCurrentHeight(): number {
    return getSharedState.lastBlockNumber
}

export const forkHandlers: Record<string, NodeCallHandler> = {
    /**
     * Returns the current fork-activation status for every known fork.
     *
     * Takes no arguments — any extras on the request payload are ignored
     * (so we don't choke on forward-compatible client extensions).
     */
    getNetworkInfo: async (_data, response) => {
        log.debug("[SERVER] Received getNetworkInfo")

        const currentHeight = readCurrentHeight()
        const osDenominationConfig =
            getSharedState.forkConfig?.osDenomination
        const activationHeight =
            osDenominationConfig?.activationHeight ?? null

        const networkInfo: NetworkInfo = {
            forks: {
                osDenomination: {
                    activationHeight,
                    activated: isForkActive("osDenomination", currentHeight),
                    currentHeight,
                },
            },
            nodeVersion: NODE_VERSION,
        }

        response.response = networkInfo
        return response
    },
}
