import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import type {
    BaseForkConfig,
    ForkConfig,
    ForkName,
    GasFeeSeparationConfig,
    OsDenominationConfig,
} from "./forkConfig"

// REVIEW: P2 + DEM-665 — genesis loader for fork heights + per-fork payloads.

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
 * Burn-address constant for the gasFeeSeparation fork (DEM-665).
 *
 * Code-baked, never genesis-driven, never rotates. Used both at fork
 * activation (the migration creates a GCR account at this pubkey with
 * balance 0) and at runtime in `gcr_routines/feeDistribution.ts` and
 * `GCRBalanceRoutines.ts`.
 *
 * Mirrored as a re-export from `migrations/gasFeeSeparation.ts` once
 * P12 lands — that file is the authoritative home. Keeping it here too
 * (as the loader needs to write it into `feeDistribution.burnAddress`
 * before the migration file exists in dependency order) avoids a
 * circular import.
 *
 * Format: lowercase hex, `0x` + 64 zero hex digits = 66 chars total.
 */
export const GAS_FEE_SEPARATION_BURN_ADDRESS = "0x" + "0".repeat(64)

/**
 * Hex address validation regex: lowercase `0x` + exactly 64 hex chars.
 *
 * Mirrors the address format used by `forgeToHex` and the rest of the
 * Demos codebase. Strict-lowercase by design: PR #778 G-1/G-4 (myc#6)
 * caught a class of bugs where mixed-case hex addresses compared unequal
 * to their lowercase forms in different code paths. Accepting only
 * lowercase here surfaces malformed genesis input at boot rather than as
 * a silent fee-distribution split at activation.
 */
const ADDRESS_HEX_PATTERN = /^0x[0-9a-f]{64}$/

/**
 * Returns true iff the rehearsal-only feature flag
 * `DEMOS_DISABLE_FORK_MACHINERY` is set to a truthy value.
 *
 * REHEARSAL-ONLY. Do NOT set this in production. Its sole purpose is to
 * allow scenarios 2 (validator desync) and 4 (genesis-hash invariance) to
 * spin up a node that behaves as if the fork machinery had not been
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
 * Hydrates `getSharedState.forkConfig` from a genesis-style payload and
 * primes `getSharedState.feeDistribution` with the consensus-fixed
 * addresses (burn + treasury) from the `gasFeeSeparation` fork payload.
 *
 * The genesis JSON may optionally include a top-level `forks` object whose
 * keys are {@link ForkName} values and whose values are per-fork
 * {@link ForkConfig} payloads. Unknown fork names are ignored with a
 * warning so a forward-dated genesis can be loaded by an older node
 * without crashing — the unknown fork simply has no rule effect.
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
 * **Fee distribution priming** (DEM-665): after fork entries are loaded,
 * `getSharedState.feeDistribution` is populated with:
 *   - `burnAddress`: code constant `GAS_FEE_SEPARATION_BURN_ADDRESS`
 *   - `treasuryAddress`: the `treasuryAddress` field of the
 *     `gasFeeSeparation` fork config (or the placeholder default if no
 *     genesis payload was supplied)
 *   - distribution percentages: NOT populated here — that step is the
 *     job of `loadNetworkParameters()`, which folds governance state
 *     and updates `feeDistribution` accordingly. Until that runs, the
 *     percentage groups are left undefined and callers in
 *     `feeDistribution.ts` must guard.
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
    if (!genesisData || typeof genesisData !== "object") {
        primeFeeDistributionFromForkConfig()
        return
    }
    const forks = genesisData.forks
    if (!forks || typeof forks !== "object") {
        primeFeeDistributionFromForkConfig()
        return
    }

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
        const config = validateForkEntry(name as ForkName, rawConfig)
        // Assignment narrowed per-fork inside the union: each branch
        // writes to the correct map key with its specialised type.
        writeForkConfig(name as ForkName, config)
        log.info(
            `[FORKS] Loaded fork "${name}" with activationHeight=${config.activationHeight}`,
        )
    }

    primeFeeDistributionFromForkConfig()
}

/**
 * Dispatch table: write a validated per-fork config into the shared
 * registry. Centralised so the union narrowing is documented in one
 * place and TS catches a missing branch when a new fork is added.
 */
function writeForkConfig(name: ForkName, config: ForkConfig): void {
    switch (name) {
        case "osDenomination":
            getSharedState.forkConfig.osDenomination =
                config as OsDenominationConfig
            return
        case "gasFeeSeparation":
            getSharedState.forkConfig.gasFeeSeparation =
                config as GasFeeSeparationConfig
            return
        default: {
            // Exhaustiveness guard — a new ForkName added to the union
            // without a case here will fail the type check.
            const _exhaustive: never = name
            void _exhaustive
            return
        }
    }
}

/**
 * Hydrate the `feeDistribution` addresses from the current `forkConfig`.
 *
 * Idempotent: callable any number of times. Only writes the
 * consensus-fixed addresses (burn + treasury) — distribution percentages
 * are populated later by `loadNetworkParameters()` and must NOT be
 * overwritten here. To preserve any percentages that were already folded
 * in (e.g. by a prior governance load), we preserve the existing
 * `networkFee` / `additionalFee` / `specialOps` groups when present.
 *
 * The treasury address is read from `forkConfig.gasFeeSeparation` (which
 * is either the placeholder default or the value provided by genesis).
 * A node booting from defaults thus sees a placeholder treasury, which is
 * fine while `activationHeight === null` — the fork-gated consumer in
 * `feeDistribution.ts` short-circuits without touching it.
 */
function primeFeeDistributionFromForkConfig(): void {
    const gfs = getSharedState.forkConfig.gasFeeSeparation
    const treasuryAddress = gfs.treasuryAddress
    const existing = getSharedState.feeDistribution
    getSharedState.feeDistribution = {
        burnAddress: GAS_FEE_SEPARATION_BURN_ADDRESS,
        treasuryAddress,
        // Preserve any pre-existing percentages (set by a prior
        // loadNetworkParameters call in tests that re-run the loader).
        // Initial production boot: these are overwritten by
        // loadNetworkParameters() before fee-distribution.ts ever fires
        // since the fork is gated.
        networkFee: existing?.networkFee ?? { burnPct: 0, treasuryPct: 0 },
        additionalFee:
            existing?.additionalFee ?? { burnPct: 0, treasuryPct: 0 },
        specialOps:
            existing?.specialOps ?? {
                burnPct: 0,
                rpcPct: 0,
                treasuryPct: 0,
            },
    }
}

/**
 * Validate the common fields shared by every fork. Returns the parsed
 * base view; per-fork validators extend this with their own payload.
 */
function parseBaseForkEntry(name: string, raw: unknown): BaseForkConfig {
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

/**
 * Validate a single `genesisData.forks.<name>` entry. Throws on any
 * malformed shape — silent skip would defeat the purpose of the
 * validation (myc#81 / GH#3213220458).
 *
 * Dispatches to per-fork validators by name so each fork can enforce
 * its own payload contract:
 *  - `osDenomination`: base fields only.
 *  - `gasFeeSeparation`: base + `treasuryAddress` (lowercase hex,
 *    `0x` + 64 hex chars).
 */
function validateForkEntry(name: ForkName, raw: unknown): ForkConfig {
    const base = parseBaseForkEntry(name, raw)
    const entry = raw as Record<string, unknown>

    switch (name) {
        case "osDenomination":
            return base as OsDenominationConfig
        case "gasFeeSeparation":
            return validateGasFeeSeparationEntry(base, entry)
        default: {
            const _exhaustive: never = name
            void _exhaustive
            throw new ForkConfigValidationError(
                `[FORKS] Unhandled fork name in validator: ${String(name)}`,
            )
        }
    }
}

/**
 * Validate the gasFeeSeparation payload.
 *
 * Required field beyond the base:
 *  - `treasuryAddress`: string matching `ADDRESS_HEX_PATTERN`
 *    (lowercase, `0x` + 64 hex digits = 66 chars). Mixed-case is
 *    rejected (PR #778 G-1/G-4 lesson, myc#6).
 *
 * Additional safety:
 *  - If `activationHeight !== null` (i.e. the fork is scheduled), the
 *    treasury address MUST NOT be the placeholder zero address.
 *    Sealing genesis with the placeholder is the most likely operator
 *    mistake — fees would be routed into the burn address and burn it
 *    twice. Fail-closed at boot rather than at activation block.
 */
function validateGasFeeSeparationEntry(
    base: BaseForkConfig,
    entry: Record<string, unknown>,
): GasFeeSeparationConfig {
    const ta = entry.treasuryAddress
    if (typeof ta !== "string") {
        throw new ForkConfigValidationError(
            `[FORKS] Genesis fork "gasFeeSeparation".treasuryAddress must be a string, got: ${typeof ta}`,
        )
    }
    if (!ADDRESS_HEX_PATTERN.test(ta)) {
        throw new ForkConfigValidationError(
            `[FORKS] Genesis fork "gasFeeSeparation".treasuryAddress must match ${ADDRESS_HEX_PATTERN.source} (lowercase 0x + 64 hex chars), got: ${JSON.stringify(ta)}`,
        )
    }
    if (
        base.activationHeight !== null &&
        ta === GAS_FEE_SEPARATION_BURN_ADDRESS
    ) {
        throw new ForkConfigValidationError(
            `[FORKS] Genesis fork "gasFeeSeparation".treasuryAddress is the placeholder zero address but activationHeight=${base.activationHeight}. Replace the placeholder with the real treasury address before sealing genesis.`,
        )
    }
    return {
        activationHeight: base.activationHeight,
        description: base.description,
        treasuryAddress: ta,
    }
}
