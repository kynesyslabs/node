import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import type { ForkConfig, ForkName } from "./forkConfig"

// REVIEW: P2 — genesis loader for fork heights.

/**
 * Returns true iff the rehearsal-only feature flag
 * `DEMOS_DISABLE_FORK_MACHINERY` is set to a truthy value.
 *
 * REHEARSAL-ONLY. Do NOT set this in production. Its sole purpose is to
 * allow scenarios 2 (validator desync) and 4 (genesis-hash invariance) to
 * spin up a node that behaves as if the P3 fork machinery had not been
 * merged — same image, but with the loader and the migration hook
 * short-circuited. This avoids maintaining a separate pre-fork branch /
 * image tag.
 *
 * Truthy values: "true", "1", "yes" (case-insensitive). Anything else
 * (including unset) is treated as false.
 */
export function isForkMachineryDisabled(): boolean {
    const raw = process.env.DEMOS_DISABLE_FORK_MACHINERY
    if (!raw) return false
    const normalized = raw.trim().toLowerCase()
    return (
        normalized === "true" || normalized === "1" || normalized === "yes"
    )
}

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
 * **Rehearsal flag**: when `DEMOS_DISABLE_FORK_MACHINERY` is set the loader
 * short-circuits and returns without parsing any fork entries — even if
 * the genesis declares them. This lets a single image act as a pre-fork
 * binary for desync / hash-invariance rehearsals. Production must NEVER
 * set this flag.
 *
 * @param genesisData Parsed genesis JSON object.
 */
export function loadForkConfigFromGenesis(genesisData: any): void {
    if (isForkMachineryDisabled()) {
        log.warning(
            "[FORKS] DEMOS_DISABLE_FORK_MACHINERY set — ignoring genesis " +
                "`forks` field (rehearsal-only behaviour, do NOT use in prod)",
        )
        return
    }
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
