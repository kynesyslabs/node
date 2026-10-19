/**
 * Canonical genesis-data normalizer for consensus-relevant hashing.
 *
 * Problem
 * -------
 * Two nodes that share the same consensus rules but list their own
 * connection URL as `localhost` (so the entry self-resolves at boot)
 * end up with different `genesisData.validators[*].connection_url`
 * values. A naive `Hashing.sha256(JSON.stringify(genesisData))` then
 * produces a different hash on each node, breaking `peerBootstrap`
 * pairing for what is otherwise an identical consensus configuration.
 *
 * `connection_url` is network topology — peer routing metadata — not
 * consensus state. The set of validators, their stakes, status, and
 * active-block windows are consensus-significant; how each node is
 * reachable on the wire is not.
 *
 * Solution
 * --------
 * This module produces a stable, canonical byte representation of
 * `genesisData` suitable for cross-node hashing:
 *
 *   1. `connection_url` is stripped from every `validators[]` entry.
 *   2. Validators are sorted by `address` to remove insertion-order
 *      sensitivity (operators editing the file by hand may reorder).
 *   3. The result is `JSON.stringify`-ed with **sorted object keys at
 *      every depth** so two semantically-equal payloads produce
 *      byte-identical output regardless of authoring tool.
 *   4. The original `genesisData` object is left untouched (deep
 *      cloning happens internally).
 *
 * Two hashes
 * -----------
 * `hashGenesisData` is what a node ADVERTISES to peers and compares with the
 * data its peers serve. It covers everything in the genesis block as stored,
 * and must stay byte-identical across builds: a node on an older build
 * compares its own full hash with the one a newer anchor advertises.
 *
 * `hashGenesisCore` leaves out the fork schedule (`forks`) and the chain id
 * (`properties.id`). An operator who schedules a fork on a running chain edits
 * the genesis FILE, while every peer still serves the block stored when the
 * chain was created; the full hashes then differ although nothing a node must
 * share since block 0 does. A node uses the core hash only to tell that kind of
 * difference from a real one; agreement on the schedule is checked separately
 * (see forkScheduleAgreement.ts).
 *
 * Callers
 * -------
 * Every site that computes a genesis-data hash for inter-peer
 * comparison MUST go through `hashGenesisData(...)`. Today that is:
 *   - `peerBootstrap.ts` (local baseline + post-fetch re-hash)
 *   - `blockHandlers.ts:getGenesisDataHash` (RPC response to peers)
 *
 * If a new call site is added, it must call this helper too — adding a
 * stringify+sha256 inline will silently re-introduce the divergence.
 */

import Hashing from "src/libs/crypto/hashing"

/**
 * Produce a deep clone of `genesisData` where every validator entry
 * has its `connection_url` field removed and the array is sorted by
 * `address`. Returns a new object; input is not mutated.
 *
 * If `genesisData.validators` is missing or not an array, the field
 * is omitted from the canonical form (treated as empty).
 */
export function canonicalGenesisForHashing(
    genesisData: unknown,
    options: { omitScheduleFields?: boolean } = {},
): Record<string, unknown> {
    if (
        genesisData === null ||
        typeof genesisData !== "object" ||
        Array.isArray(genesisData)
    ) {
        // Defensive: a non-object input cannot represent valid genesis
        // data. Coerce to an empty object so the downstream hash is
        // deterministic rather than throwing here (callers detect the
        // mismatch by hash, not by exception).
        return {}
    }

    const src = genesisData as Record<string, unknown>
    const out: Record<string, unknown> = {}

    for (const key of Object.keys(src)) {
        if (key === "validators") continue
        if (options.omitScheduleFields) {
            if (key === "forks") continue
            const props = src[key]
            if (
                key === "properties" &&
                props !== null &&
                typeof props === "object" &&
                !Array.isArray(props)
            ) {
                const { id: _chainId, ...rest } = props as Record<string, unknown>
                out.properties = rest
                continue
            }
        }
        // Shallow copy; nested objects/arrays inside genesis are
        // already content-addressed (balances, forks, properties,
        // mutables) — their authoring order is fixed by the genesis
        // file and stable across all peers using the same file. We
        // do NOT need to recursively sort their keys; we only sort
        // the OUTER stringify pass below.
        out[key] = src[key]
    }

    const rawValidators = src.validators
    if (Array.isArray(rawValidators)) {
        const stripped = rawValidators.map(v => {
            if (v === null || typeof v !== "object") return v
            const entry = v as Record<string, unknown>
            const copy: Record<string, unknown> = {}
            for (const k of Object.keys(entry)) {
                if (k === "connection_url") continue
                copy[k] = entry[k]
            }
            return copy
        })

        stripped.sort((a, b) => {
            const aAddr =
                a && typeof a === "object" && "address" in a
                    ? String((a as Record<string, unknown>).address ?? "")
                    : ""
            const bAddr =
                b && typeof b === "object" && "address" in b
                    ? String((b as Record<string, unknown>).address ?? "")
                    : ""
            if (aAddr < bAddr) return -1
            if (aAddr > bAddr) return 1
            return 0
        })

        out.validators = stripped
    }

    return out
}

/**
 * Deterministic JSON serialiser with lexicographically-sorted keys at
 * every depth. Arrays are walked element-wise; primitives pass through
 * `JSON.stringify` as-is.
 *
 * Note: this is a small in-file helper. The repo has no canonical JSON
 * library and the input shape is bounded (genesis is human-edited and
 * small), so a 30-line stable stringifier is cheaper than pulling in
 * `fast-json-stable-stringify` for one consumer.
 */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value)
    }

    if (Array.isArray(value)) {
        const parts = value.map(v => stableStringify(v))
        return "[" + parts.join(",") + "]"
    }

    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts = keys.map(k => JSON.stringify(k) + ":" + stableStringify(obj[k]))
    return "{" + parts.join(",") + "}"
}

/**
 * Hash a `genesisData` object for cross-node comparison.
 *
 * Canonicalises (strip `connection_url`, sort validators by address),
 * stably stringifies (lex-sorted keys at every depth), and SHA-256s.
 *
 * Any two nodes whose genesis files differ ONLY in
 * `validators[*].connection_url` (or in object-key authoring order)
 * will produce the same hash here.
 */
export function hashGenesisData(genesisData: unknown): string {
    const canonical = canonicalGenesisForHashing(genesisData)
    return Hashing.sha256(stableStringify(canonical))
}

/**
 * Hash of the genesis data without the fork schedule and the chain id.
 * Never advertised to peers; see the "Two hashes" note above.
 */
export function hashGenesisCore(genesisData: unknown): string {
    const canonical = canonicalGenesisForHashing(genesisData, {
        omitScheduleFields: true,
    })
    return Hashing.sha256(stableStringify(canonical))
}
