/**
 * Fork configuration registry.
 *
 * P2 of the DEM → OS denomination migration introduces *hard-fork machinery*
 * without activating any rule changes. Every fork declared here defaults to
 * `activationHeight: null`, which the gate function (see `forkGates.ts`)
 * treats as "never active". Behavior in P2 is therefore bit-identical to
 * pre-P2 — the gate exists in the right places but always falls through to
 * the legacy code path.
 *
 * Activation heights are eventually loaded from `data/genesis.json` via the
 * loader in `findGenesisBlock.ts` and hydrated into `SharedState.forkConfig`
 * at startup (see `src/utilities/sharedState.ts`).
 */

// REVIEW: P2 — fork config registry; no rule changes yet.

/**
 * Configuration for a single fork.
 *
 * @property activationHeight Block height at which the fork rules become
 *   active. `null` means the fork is configured but not scheduled and will
 *   never activate.
 * @property description Optional human-readable rationale, surfaced for
 *   operators / diagnostics. Not consumed by consensus.
 */
export interface ForkConfig {
    activationHeight: number | null
    description?: string
}

/**
 * Centralized registry of known fork names. Keeping this as a literal union
 * means typos surface at compile time rather than being silently treated as
 * "unknown fork → inactive".
 */
export type ForkName = "osDenomination"

/**
 * Default fork configuration. Every fork starts inactive (`null`) so that a
 * node booting without a `forks` section in genesis is bit-identical to a
 * pre-P2 node. Genesis can override individual entries via
 * `genesisData.forks`.
 */
export const DEFAULT_FORK_CONFIG: Record<ForkName, ForkConfig> = {
    osDenomination: {
        activationHeight: null,
        description:
            "DEM→OS denomination change. amount field becomes OS string.",
    },
}

/**
 * Deep-copy helper for the default config. The default object is exported
 * as a constant for documentation purposes; runtime state must own its own
 * copy so per-instance mutation (e.g. genesis loading) does not leak into
 * the module-level constant.
 */
export function cloneDefaultForkConfig(): Record<ForkName, ForkConfig> {
    return {
        osDenomination: { ...DEFAULT_FORK_CONFIG.osDenomination },
    }
}
