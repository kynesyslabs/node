# PR 695 New Review Sweep

Source review: `https://github.com/kynesyslabs/node/pull/695#pullrequestreview-4007691667`

## Raw New Bot Comments

### Actionable

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116274`
  - `scripts/semantic-map/embed_local.py`
  - Duplicate UUIDs are not rejected before row-indexed embedding output is written.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116285`
  - `scripts/semantic-map/embed.ts`
  - HTTP embedding response validation checks array shape but not that every value is a finite number.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116321`
  - `scripts/semantic-map/embed.ts`
  - Duplicate UUIDs are not rejected before `uuid-mapping.json` is emitted.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116331`
  - `specs/ipfs-reference/10-configuration.mdx`
  - Docs still normalize a built-in fallback swarm key for private-network deployments.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116334`
  - `specs/ipfs-reference/10-configuration.mdx`
  - Docs/snippet do not validate `DEMOS_IPFS_SWARM_KEY` format before writing `swarm.key`.

### Already Fixed / Do Not Track Again

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116222`
  - `.serena/memories/arch_hook_system.md`
  - Resolved by commit `79f5b48`.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116246`
  - `.serena/memories/arch_hook_system.md`
  - Resolved by commit `79f5b48`.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116260`
  - `.serena/memories/arch_hook_system.md`
  - Resolved by commit `79f5b48`.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116268`
  - `.serena/memories/arch_hook_system.md`
  - Resolved by commit `79f5b48`.

- `https://github.com/kynesyslabs/node/pull/695#discussion_r2989116359`
  - `src/config/loader.ts`
  - Follow-up review confirms the existing `serverPort + 1` fallback is correct. No new task.

### Nitpicks / Not Tracking

- Review body nit: `scripts/semantic-map/embed_local.py`
  - UUID formatting is inconsistent between “no descriptions” and “descriptions present” cases.
  - Verdict: not worth tracker state unless we decide to change embedding text format intentionally.

- Review body nit: `scripts/semantic-map/embed_local.py`
  - Replace inline `__import__("datetime")` / `datetime.utcnow()` with explicit imports.
  - Verdict: style cleanup only.

- Review body advisory: `src/config/loader.ts` -> runtime metrics
  - `MetricsCollector` may read configured Omni port instead of the runtime port chosen by `getNextAvailablePort`.
  - Verdict: plausible but pre-existing and not part of the current inline action set.

## Polished Tracker Decisions

- Add a Mycelium task for duplicate UUID validation across both semantic-map embedding entrypoints.
- Add a Mycelium task for finite-number validation of provider embedding vectors in `scripts/semantic-map/embed.ts`.
- Add a Mycelium task for IPFS private-network docs hardening so the configuration reference requires an explicit unique swarm key and validates its format in the example init script.
