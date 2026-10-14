import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "@/forks/forkGates"
import log from "@/utilities/logger"
import { NODE_VERSION, type NodeVersionInfo } from "@/utilities/nodeVersion"
import type { ForkName } from "@/forks/forkConfig"
import {
    forkScheduleDigest,
    type ForkConfigLike,
} from "@/libs/peer/routines/forkScheduleAgreement"
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
    /**
     * Every registered fork, so an operator can read the whole schedule from
     * the node. The three named below are the ones clients act on; the rest
     * are reported for the same reason as `forkScheduleDigest`.
     */
    forks: {
        osDenomination: ForkStatus
        signatureDomain: ForkStatus
        web2ProofBinding: ForkStatus
    } & Record<string, ForkStatus>
    /**
     * Digest of the whole fork schedule and the chain id (see
     * `forkScheduleAgreement.ts`). Peers compare it to notice a node that
     * missed a genesis edit. Absent on nodes older than this field.
     */
    forkScheduleDigest: string
    /**
     * Network identity from genesis `properties.id`. A signer needs it to
     * build the transaction signature preimage once `signatureDomain` is
     * active, and it is what stops a signature from being replayed on
     * another chain. Null on a node whose genesis declared none — such a
     * node cannot activate the fork.
     */
    chainId: number | null
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

        // The RPC server is up before the fork configuration is read at boot.
        // Until then the defaults would be reported as this node's schedule.
        if (!getSharedState.forkConfigLoaded) {
            response.result = 503
            response.response = {
                error: "STATE_NOT_READY",
                message: "Fork configuration not loaded yet",
            }
            return response
        }

        const currentHeight = readCurrentHeight()
        const forkConfig = getSharedState.forkConfig

        // signatureDomain and web2ProofBinding are judged at admission for the
        // block a transaction or proof would land in, so they answer for the
        // next block; a wallet asking at tip H-1 is about to sign for block H
        // and must already be told to use the new rules. The others keep the
        // tip, as osDenomination always did.
        const forks: Record<string, ForkStatus> = {}
        for (const name of Object.keys(forkConfig) as ForkName[]) {
            const nextBlock = name === "signatureDomain" || name === "web2ProofBinding"
            forks[name] = {
                activationHeight: forkConfig[name]?.activationHeight ?? null,
                activated: isForkActive(name, currentHeight + (nextBlock ? 1 : 0)),
                currentHeight,
            }
        }

        const networkInfo: NetworkInfo = {
            forks: forks as NetworkInfo["forks"],
            forkScheduleDigest: forkScheduleDigest(
                forkConfig as unknown as ForkConfigLike,
                getSharedState.chainId,
            ),
            chainId: getSharedState.chainId,
            nodeVersion: NODE_VERSION,
        }

        response.response = networkInfo
        return response
    },
}
