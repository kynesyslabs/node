/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * DEM-665 — single source of truth for the burn-address constant.
 *
 * Lives in its own leaf module so both `loadForkConfig.ts` (the
 * runtime spend-prevention path) and `migrations/gasFeeSeparation.ts`
 * (the state-migration account-creation path) can import it without
 * pulling each other's transitive deps and without re-declaring the
 * value at two call sites.
 *
 * PR #817 Greptile P1 flagged the prior duplicate definitions
 * (`GAS_FEE_SEPARATION_BURN_ADDRESS` in `loadForkConfig.ts` and
 * `BURN_ADDRESS` in `migrations/gasFeeSeparation.ts`) as a divergence
 * risk: the migration would create the burn account at one literal
 * while the spend-prevention guard could read from another. Equality
 * was test-time-only, not compile-time. Consolidating here makes the
 * invariant structural.
 *
 * Format: lowercase hex, `0x` + 64 zero hex digits = 66 chars total.
 * Never rotates, never genesis-driven, identical across every chain.
 */

export const BURN_ADDRESS = "0x" + "0".repeat(64)
