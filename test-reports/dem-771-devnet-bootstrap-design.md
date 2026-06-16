# DEM-771 — Make node start/restart smooth: design

Author: shitikyan
Date: 2026-06-16
Status: Implemented in PR #943 (sections 4.1 and 4.2 are bundled into a single routine; rollout plan in §7 reflects the unified shape).

## 1. Scope

**Goal**: one invocation of `./run` on a single node ALWAYS lands in one
of two terminal states — clean boot, or hard fail with the exact
remediation command in the log. No silent "running but dead", no manual
multi-step recovery for the operator.

**Non-scope**: multi-node orchestration, SSH/remote coordination,
operator-side scripts that talk to N hosts. Each node owns its own
recovery. Peer catch-up (block sync between nodes) is already handled
by the existing OmniProtocol stack and is out of scope.

## 2. Symptom

On restart the node ends up with `validators` table empty, RPC keeps
answering, `/health` reports green, but `confirm()` returns 401 because
quorum cannot be reached against zero validators. The operator has no
signal that the chain is dead until they manually call `getValidators`.

## 3. Root cause

Validator seeding only runs inside `generateGenesisBlock()` —
[chainGenesis.ts:143-193](src/libs/blockchain/chainGenesis.ts#L143-L193) —
and `generateGenesisBlock` is only called when block 0 is missing from
the DB. The early-return in
[findGenesisBlock.ts:87-91](src/libs/blockchain/routines/findGenesisBlock.ts#L87-L91)
short-circuits the seeding path:

```ts
const genesisBlockHash = await Chain.getGenesisBlockHash()
if (genesisBlockHash) {
    log.info(`[GENESIS] Genesis block found. Hash: ${genesisBlockHash}`)
    return            // seed never re-runs
}
```

If the `validators` table is empty for ANY reason while block 0 is
present, the chain is permanently broken without manual intervention.
And the broken state is invisible: `getShard()` returns 0 peers,
consensus silently does nothing, the process keeps running.

## 4. Design

Three changes. Each one is small and independently mergeable.

### 4.1. Idempotent re-seed + integrated self-check on boot

**File**: new `src/libs/blockchain/routines/ensureValidatorSeed.ts`.
**Wired into**: `src/index.ts` immediately after `findGenesisBlock()`.

The routine bundles the re-seed and the fail-loud self-check (originally
sketched separately in §4.2) into a single function: the only sensible
"empty validators table + nothing to seed" handling is to throw with the
operator-actionable message, so it lives in the same place.

```ts
export async function ensureValidatorSeed(genesisData: unknown) {
    const existing = await countValidators()
    if (existing > 0) return { reseeded: false, count: existing }   // healthy

    const seed = extractSeed(genesisData)
    if (seed.length === 0) {
        // Integrated self-check (was §4.2): nothing left to do; node
        // would otherwise come up with quorum impossible.
        throw new ConsensusInvariantError(
            "[BOOT] validators table empty and data/genesis.json " +
            "carries no validator set; chain cannot reach consensus. " +
            "Restore data/snapshot/ from a healthy peer and re-run with " +
            "`./run --reset`, or fix data/genesis.json.",
        )
    }
    seed.forEach(validateSeedEntry)

    await db.transaction(em => upsertValidators(em, seed))   // ON CONFLICT DO NOTHING
    const after = await countValidators()
    if (after === 0) {
        throw new ConsensusInvariantError(
            "[BOOT] validator re-seed produced 0 rows; aborting boot.",
        )
    }
    return { reseeded: true, count: after }
}
```

**Safety**: the gate `existing > 0` means we never resurrect addresses
that legitimately unstaked — if the dynamic set has even one entry, we
leave the table alone. We only re-seed when the table is fully empty,
which is unambiguously a broken state.

**Effect**: the previously silent failure mode (empty validators →
silent quorum death) self-heals at boot; truly unrecoverable state
fails loud with the remediation command embedded in the error message.

### 4.2. Fail-loud self-check — bundled into 4.1

Originally outlined as a separate post-call check in `src/index.ts`.
The implementation collapses it into `ensureValidatorSeed` itself:
there is no reasonable handling of "validators empty + nothing to
seed" other than throwing, so the throw lives next to the read.

The boot wire in `src/index.ts` is therefore a single
`await ensureValidatorSeed(genesisData)` call (preceded by a defensive
read of `data/genesis.json` whose IO/parse errors are logged rather
than swallowed).

### 4.3. `./run --reset` — one-command clean restart

The current `scripts/wipe-and-reboot.sh` already implements the
destructive recovery for the bare-metal/docker stack; it has a
`--yes` flag for unattended use. It is **mainnet-stack only** today.

Two surgical extensions:

1. Add a `--devnet` flag that points it at the devnet compose project
   (`demos-devnet`, `demos_*_devnet` volume names). Existing logic and
   safety prompts unchanged otherwise.
2. Expose it via `./run --reset` (bare-metal) and `./run --docker
   --reset` (docker) as the canonical entry point. Underlying script
   stays where it is.

After 4.1 lands, `./run --reset` is rarely needed — boot self-heals.
It stays as the "I want a known-clean state from scratch" command.

## 5. What the operator workflow looks like after

- Routine restart: `./run` (or `./run --docker`). If validators were
  somehow emptied, boot logs `[BOOT] validators table empty;
  re-seeding…` and the node comes up healthy.
- Unrecoverable state (no genesis-baked validators, no snapshot): node
  refuses to start with a one-line remediation in the log.
- Clean slate wanted: `./run --reset` wipes volumes, rebuilds, boots,
  tails the genesis log lines.

No SSH. No remote coordination. No memorising a 6-step procedure.

## 6. What we explicitly do not do

- **P2P validator-set sync** (gossip the active validator set to
  late-joining peers). Useful but separate; not required to fix the
  current pain.
- **Auto-reseed when count > 0**. If the table has any rows, we trust
  whatever consensus + staking placed there. Re-seeding would mask
  bugs and resurrect unstaked addresses.
- **Change the existing `seedValidators.ts` preflight** (requires
  empty table on first genesis). The new path is a separate function
  with UPSERT semantics; the original is left untouched.

## 7. Rollout

Shipped as a single PR (#943) rather than the originally-sketched
three: the boot self-check (§4.2) collapses into `ensureValidatorSeed`
itself, leaving two units of work that are too small to split.

1. **PR-1 / #943** — `ensureValidatorSeed` (re-seed + integrated
   fail-loud self-check) + unit tests + wire into `src/index.ts` +
   `wipe-and-reboot.sh --devnet` + `./run --docker --reset` /
   `./run --docker --devnet --reset` dispatch.

Future follow-ups (separate tickets, not blocking this fix):

- P2P validator-set sync (gossip the active set to late-joining
  peers without requiring a local snapshot).
- Migrate the `./run` wrapper toward a subcommand surface
  (`./run reset`, `./run status`, ...) once more operator
  workflows accumulate.
