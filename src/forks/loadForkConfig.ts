import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import type { ForkConfig, ForkName } from "./forkConfig"

// REVIEW: P2 — genesis loader for fork heights.

/**
 * Thrown by `loadForkConfigFromGenesis` (and the env-var production guard)
 * when a configuration value is structurally or semantically invalid. The
 * caller in `findGenesisBlock` discriminates on this class to refuse boot
 * on validation failures while still warning-and-continuing on benign
 * IO/parse errors.
 *
 * GH#3214986124 (Greptile P1): plain `Error` was being swallowed by the
 * outer try/catch, silently leaving forks inactive on a typo.
 */
export class ForkConfigValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ForkConfigValidationError"
    }
}

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
 *
 * **Production guard** (myc#82, GH#3213217875): a misconfigured production
 * validator with this flag set silently skips both the genesis fork
 * loader and the block-N migration hook, causing a consensus split when
 * peers cross the activation height. To surface that misconfiguration as
 * a hard failure rather than a warning easily missed in noisy startup
 * logs, when `NODE_ENV === 'production'` AND this function is about to
 * return `true` we:
 *
 *  1. Emit a `log.error` line that explicitly names the consensus-split
 *     risk and the variable that must be unset.
 *  2. Throw a fatal `Error` so the node refuses to boot — UNLESS the
 *     operator also sets `DEMOS_REHEARSAL=true`, which is the documented
 *     opt-in escape hatch for the rehearsal harness when it
 *     intentionally runs against a production-shaped image (NODE_ENV is
 *     `development` for the harness today, but the escape hatch lets a
 *     future operator pin `NODE_ENV=production` for a production-image
 *     rehearsal without bricking the node).
 *
 * The pre-flight checklist in `RUNBOOK_FORK_ACTIVATION.md` is updated to
 * grep `DEMOS_DISABLE_FORK_MACHINERY` in env files / docker-compose so
 * this guard is the second line of defence, not the first.
 */
export function isForkMachineryDisabled(): boolean {
    const raw = process.env.DEMOS_DISABLE_FORK_MACHINERY
    if (!raw) return false
    const normalized = raw.trim().toLowerCase()
    const disabled =
        normalized === "true" || normalized === "1" || normalized === "yes"
    if (!disabled) return false

    // Hard guard against production accidents.
    if (process.env.NODE_ENV === "production") {
        const rehearsalOptIn = (process.env.DEMOS_REHEARSAL ?? "")
            .trim()
            .toLowerCase()
        const isRehearsalOptIn =
            rehearsalOptIn === "true" ||
            rehearsalOptIn === "1" ||
            rehearsalOptIn === "yes"

        log.error(
            "[FORKS] DEMOS_DISABLE_FORK_MACHINERY is set in a NODE_ENV=" +
                "production context. This DISABLES the genesis fork loader " +
                "and the block-N migration hook, which will cause a " +
                "consensus split the moment peers cross the fork activation " +
                "height. Unset DEMOS_DISABLE_FORK_MACHINERY immediately " +
                "(or set DEMOS_REHEARSAL=true if this is a deliberate " +
                "production-image rehearsal). See RUNBOOK_FORK_ACTIVATION.md.",
        )

        if (!isRehearsalOptIn) {
            throw new ForkConfigValidationError(
                "[FORKS] Refusing to boot: DEMOS_DISABLE_FORK_MACHINERY is " +
                    "set in NODE_ENV=production without DEMOS_REHEARSAL=true " +
                    "opt-in. This combination would cause a consensus split " +
                    "across the fork activation height. Unset " +
                    "DEMOS_DISABLE_FORK_MACHINERY before restarting.",
            )
        }
    }
    return true
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
        // myc#81 / GH#3213220458: use Object.hasOwn instead of `name in
        // …` to avoid prototype-walking into Object.prototype keys
        // (e.g. a malicious genesis with a `__proto__`/`toString`
        // entry would otherwise pass the membership check and write
        // into the shared registry).
        if (!Object.hasOwn(getSharedState.forkConfig, name)) {
            log.warning(
                `[FORKS] Genesis declares unknown fork "${name}" — ignoring`,
            )
            continue
        }
        // Strict validation: malformed entries throw rather than being
        // silently coerced to `null` (inactive). Silent fallback would
        // turn a misconfigured activation height into a consensus-time
        // surprise; the loader is the right place to refuse to boot.
        const config = validateForkEntry(name, rawConfig)
        getSharedState.forkConfig[name as ForkName] = config
        log.info(
            `[FORKS] Loaded fork "${name}" with activationHeight=${config.activationHeight}`,
        )
    }
}

/**
 * Validate a single `genesisData.forks.<name>` entry.
 *
 * Throws on any malformed shape — silent skip would defeat the purpose
 * of the validation. The accepted contract:
 *
 *  - `rawConfig` MUST be a non-null object.
 *  - `activationHeight` MUST be either `null` (fork configured but
 *    inactive) or a non-negative finite integer. NaN, Infinity,
 *    fractional, negative, undefined-not-null, and non-number values
 *    are all hard errors.
 *  - `description` is optional; when present it MUST be a string.
 *    Non-string values are dropped (the field is operator-facing only,
 *    not consensus-relevant) but logged via `log.warning`.
 *
 * myc#81 / GH#3213220458.
 */
function validateForkEntry(name: string, raw: unknown): ForkConfig {
    if (typeof raw !== "object" || raw === null) {
        throw new ForkConfigValidationError(
            `[FORKS] Genesis fork "${name}" must be an object, got: ${typeof raw}`,
        )
    }
    const entry = raw as Record<string, unknown>
    const ah = entry.activationHeight
    if (
        ah !== null &&
        (typeof ah !== "number" ||
            !Number.isFinite(ah) ||
            !Number.isInteger(ah) ||
            ah < 0)
    ) {
        throw new ForkConfigValidationError(
            `[FORKS] Genesis fork "${name}".activationHeight must be a non-negative integer or null, got: ${JSON.stringify(ah)}`,
        )
    }
    let description: string | undefined
    if (typeof entry.description === "string") {
        description = entry.description
    } else if (typeof entry.description !== "undefined") {
        log.warning(
            `[FORKS] Genesis fork "${name}".description must be a string when present, got: ${typeof entry.description}; ignoring`,
        )
    }
    return { activationHeight: ah as number | null, description }
}
