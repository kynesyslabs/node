import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import type { ForkConfig, ForkName } from "./forkConfig"

// REVIEW: P2 — genesis loader for fork heights.

/**
 * Hydrates `getSharedState.forkConfig` from a genesis-style payload.
 *
 * The genesis JSON may optionally include a top-level `forks` object whose
 * keys are {@link ForkName} values and whose values are {@link ForkConfig}
 * payloads. Unknown fork names are ignored with a warning so a forward-dated
 * genesis can be loaded by an older node without crashing — the unknown
 * fork simply has no rule effect.
 *
 * Absence of the `forks` field is the supported default and leaves the
 * config in its `cloneDefaultForkConfig()` state (all forks inactive).
 *
 * @param genesisData Parsed genesis JSON object.
 */
export function loadForkConfigFromGenesis(genesisData: any): void {
    if (!genesisData || typeof genesisData !== "object") return
    const forks = genesisData.forks
    if (!forks || typeof forks !== "object") return

    for (const [name, rawConfig] of Object.entries(forks)) {
        if (!(name in getSharedState.forkConfig)) {
            log.warning(
                `[FORKS] Genesis declares unknown fork "${name}" — ignoring`,
            )
            continue
        }
        const config = rawConfig as Partial<ForkConfig>
        const activationHeight =
            typeof config.activationHeight === "number"
                ? config.activationHeight
                : null
        getSharedState.forkConfig[name as ForkName] = {
            activationHeight,
            description: config.description,
        }
        log.info(
            `[FORKS] Loaded fork "${name}" with activationHeight=${activationHeight}`,
        )
    }
}
