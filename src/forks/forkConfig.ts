/**
 * Fork configuration registry.
 *
 * P2 of the DEM → OS denomination migration introduced *hard-fork machinery*
 * without activating any rule changes. DEM-665 (gas fee separation) adds a
 * second fork name and extends the config shape to a discriminated union:
 * each fork may carry its own payload alongside the common
 * `activationHeight` / `description` fields.
 *
 * Activation heights and per-fork payloads are loaded from `data/genesis.json`
 * via the loader in `loadForkConfig.ts` and hydrated into
 * `SharedState.forkConfig` at startup (see `src/utilities/sharedState.ts`).
 *
 * Distribution percentages for gas-fee separation do NOT live here — they
 * are governance-mutable via NetworkParameters. Only the fork-level
 * immutable bits (treasuryAddress) ride in the fork payload. Burn address
 * is a code constant in `migrations/gasFeeSeparation.ts`, never genesis-
 * driven.
 */

// REVIEW: DEM-665 — fork config registry extended for gasFeeSeparation.

/**
 * Common fields every fork config carries. Per-fork variants extend this
 * with their own payload (see `OsDenominationConfig`,
 * `GasFeeSeparationConfig`).
 *
 * @property activationHeight Block height at which the fork rules become
 *   active. `null` means the fork is configured but not scheduled and will
 *   never activate.
 * @property description Optional human-readable rationale, surfaced for
 *   operators / diagnostics. Not consumed by consensus.
 */
export interface BaseForkConfig {
    activationHeight: number | null
    description?: string
}

/**
 * `osDenomination` fork: DEM → OS migration. No payload beyond the base.
 *
 * Declared as a `type` alias rather than an empty `interface … extends`
 * to avoid the eslint `@typescript-eslint/no-empty-object-type` rule
 * (CodeRabbit PR #817 feedback). Structurally identical to
 * `BaseForkConfig`; consumers narrow via `ForkName`, not via runtime
 * shape.
 */
export type OsDenominationConfig = BaseForkConfig

/**
 * `gasFeeSeparation` fork (DEM-665): splits the single lump-sum gas fee
 * into three components (network / rpc / additional) with distinct
 * distribution rules, plus a new special-ops rule for TLSN.
 *
 * Payload:
 *  - `treasuryAddress`: ed25519 public key (lowercase hex, `0x` + 64 hex
 *    chars = 66 chars total) that receives the treasury portion of every
 *    fee distribution. Consensus-significant — must match across all
 *    validators. Phase 1 is immutable fork-payload; a future epic may
 *    migrate ownership to governance.
 *
 * Burn address is a code constant (`0x` + 64 zeros), NOT in genesis —
 * it never rotates. Distribution percentages live in NetworkParameters
 * (governable from day 1 with tight bounds + sum-100 invariant).
 */
export interface GasFeeSeparationConfig extends BaseForkConfig {
    treasuryAddress: string
}

/**
 * Discriminated union over all known fork configs. The discriminant is
 * the key in `Record<ForkName, ForkConfig>` (not a tag on the value),
 * so consumers narrow by reading via `forkConfig.gasFeeSeparation` etc.
 */
export type ForkConfig = OsDenominationConfig | GasFeeSeparationConfig

/**
 * Centralized registry of known fork names. Keeping this as a literal union
 * means typos surface at compile time rather than being silently treated as
 * "unknown fork → inactive".
 */
export type ForkName = "osDenomination" | "gasFeeSeparation"

/**
 * Per-fork type map. Used by the loader and gates to narrow the union by
 * fork name without runtime type checks.
 */
export interface ForkConfigByName {
    osDenomination: OsDenominationConfig
    gasFeeSeparation: GasFeeSeparationConfig
}

/**
 * Placeholder treasury address used when no genesis payload is supplied.
 * DEM-665: chain-wipe operators replace this with the real treasury hex
 * before sealing genesis. A node booting with the placeholder treasury
 * is bit-identical to a pre-fork node only while
 * `gasFeeSeparation.activationHeight === null` — once active, treasury
 * fees would land here, so it MUST be replaced before activation.
 *
 * Format: lowercase hex, `0x` + 64 zero hex digits. Same shape (and the
 * same value, deliberately) as the burn address constant in
 * `migrations/gasFeeSeparation.ts`. Distinguishing the two by value is
 * intentional in production genesis; sharing the zero address in the
 * placeholder is purely a syntactic default — the loader rejects this
 * value when `activationHeight !== null`.
 */
export const PLACEHOLDER_TREASURY_ADDRESS =
    "0x" + "0".repeat(64)

/**
 * Default fork configuration.
 *
 * `osDenomination` defaults to `activationHeight: 0` — fresh chains
 * boot post-fork by default. Rationale: every Demos chain shipped via
 * `./run -b true` / `wipe_and_reboot.sh` / docker --clean is a brand-new
 * chain with no pre-fork peers to maintain wire compatibility with. The
 * previous default (`null`) was a backwards-compatibility hedge for the
 * incentives-campaign testnet that crossed the fork mid-flight; that
 * window has closed. Operators upgrading an existing pre-fork chain
 * MUST still pin `activationHeight: <future block>` explicitly in
 * `data/genesis.json.forks.osDenomination` and roll the upgrade in
 * lock-step with their peers — overriding the default to `null` is
 * supported and remains the safe path for a live cross-fork upgrade.
 *
 * `gasFeeSeparation` stays inactive by default because its activation
 * also requires a real treasury address — the placeholder zero address
 * is rejected by the loader when `activationHeight !== null`. Operators
 * who want this fork active on a fresh chain set both fields explicitly.
 *
 * Genesis can override any entry via `genesisData.forks`.
 */
export const DEFAULT_FORK_CONFIG: ForkConfigByName = {
    osDenomination: {
        activationHeight: 0,
        description:
            "DEM→OS denomination change. amount field becomes OS string.",
    },
    gasFeeSeparation: {
        activationHeight: null,
        description:
            "Gas fee separation (DEM-665). Splits gas into network/rpc/additional " +
            "components with per-component burn/treasury/rpc-operator distribution.",
        treasuryAddress: PLACEHOLDER_TREASURY_ADDRESS,
    },
}

/**
 * Deep-copy helper for the default config. The default object is exported
 * as a constant for documentation purposes; runtime state must own its own
 * copy so per-instance mutation (e.g. genesis loading) does not leak into
 * the module-level constant.
 */
export function cloneDefaultForkConfig(): ForkConfigByName {
    return {
        osDenomination: { ...DEFAULT_FORK_CONFIG.osDenomination },
        gasFeeSeparation: { ...DEFAULT_FORK_CONFIG.gasFeeSeparation },
    }
}
