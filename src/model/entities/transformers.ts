/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * Shared TypeORM column transformers.
 *
 * REVIEW: Postgres `numeric` is the only built-in numeric type wide enough
 * to safely hold post-fork OS balances (1 DEM = 10^9 OS, and the production
 * genesis already seeds at 10^18 DEM-magnitude — `bigint` would overflow on
 * the very first `balance * 10^9` UPDATE in the osDenomination migration).
 *
 * Postgres returns `numeric` columns to TypeORM as **strings** by default
 * to preserve arbitrary precision. The application layer reads
 * `gcr_main.balance` as `bigint`, so we need a transformer to bridge the
 * driver-level string back to a `bigint` at the ORM boundary. Without this
 * transformer the field would silently change shape from `bigint` to
 * `string` for every read, breaking arithmetic at every call site.
 *
 * NOTE: This transformer ONLY runs through the entity / repository API.
 * Raw `entityManager.query("SELECT balance FROM gcr_main")` calls bypass
 * the transformer and return the driver-native string. Callers of raw
 * queries must coerce explicitly via `BigInt(row.balance)`.
 */
export const bigintNumericTransformer = {
    /**
     * Persist side: ORM has a `bigint`; the driver expects a string for
     * `numeric` columns. `null`/`undefined` are passed through so nullable
     * columns continue to round-trip a SQL NULL.
     */
    to: (value: bigint | null | undefined): string | null => {
        if (value === null || value === undefined) return null
        return value.toString()
    },
    /**
     * Hydrate side: driver hands us a string (Postgres) or a number (sqlite
     * — used in unit tests). String inputs are intrinsically lossless when
     * fed to `BigInt(string)`; number inputs are NOT — sqlite drivers
     * coerce wide `numeric` values to JS `number` before this transformer
     * runs, and any value beyond `Number.MAX_SAFE_INTEGER` (2^53−1) has
     * already lost precision before we see it. Production fixtures already
     * reach 1e16 OS magnitudes (10_000_000 DEM × 10^9), so silently
     * accepting an unsafe number would produce wrong post-fork balances on
     * the unit-test path while remaining correct on the Postgres path.
     *
     * Validate the number-shape branch with `Number.isSafeInteger` and
     * throw a descriptive `RangeError` if it fails. The string branch is
     * unchanged; `null`/`undefined` pass through.
     *
     * NOTE: this guard is the load-bearing safety for the sqlite test
     * path. Production uses Postgres' string round-trip which is
     * intrinsically safe.
     */
    from: (value: string | number | null | undefined): bigint | null => {
        if (value === null || value === undefined) return null
        if (typeof value === "number") {
            if (!Number.isSafeInteger(value)) {
                throw new RangeError(
                    "[bigintNumericTransformer] driver returned a JS number " +
                        "outside Number.MAX_SAFE_INTEGER bounds " +
                        `(value=${value}); precision was already lost ` +
                        "before BigInt() coercion. This typically means a " +
                        "sqlite-backed test environment hit a post-fork OS " +
                        "magnitude. Use Postgres for fixtures > 2^53-1.",
                )
            }
        }
        return BigInt(value)
    },
}
