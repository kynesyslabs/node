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

The routine bundles the re-seed, source-priority decision, and the
fail-loud self-check (originally sketched separately in §4.2) into a
single function. The recovery order is the critical part — naive
"seed from genesis whenever empty" is unsafe on mainnet because
genesis-baked addresses may have legitimately unstaked, and any
validator that staked after block 0 is not represented in
`data/genesis.json`. The snapshot is the authoritative
state-at-snapshot-time and includes every dynamic stake event up to
that point, so it is the safe primary source on an advanced chain.

```ts
export async function ensureValidatorSeed(genesisData: unknown) {
    const existing = await countValidators()
    if (existing > 0) return { reseeded: false, count: existing, source: null }

    const lastBlock = await Chain.getLastBlockNumber()

    // 1. Primary: snapshot (authoritative at snapshot-time, includes
    //    post-genesis stakers).
    const snapshotRows = await loadSnapshotValidators()   // [] on v1 / missing / IO error
    if (snapshotRows.length > 0) {
        await db.transaction(em => upsertValidators(em, snapshotRows))
        return { reseeded: true, count: ..., source: "snapshot" }
    }

    // 2. Fallback: genesis-baked, BUT only at block 0. Auto-seeding
    //    from genesis after the chain has advanced would revert the
    //    validator set to the founders and silently lose every
    //    dynamic staker.
    if (lastBlock > 0) {
        throw new ConsensusInvariantError(
            `[BOOT] validators table empty at block ${lastBlock} and no ` +
            `usable snapshot. Restore data/snapshot/ from a healthy peer ` +
            `and re-run, or accept a full wipe via \`./run --docker --reset\`.`,
        )
    }

    const seed = extractGenesisSeed(genesisData)
    if (seed.length === 0) {
        throw new ConsensusInvariantError(
            "[BOOT] neither snapshot nor genesis has validators; " +
            "chain cannot reach consensus.",
        )
    }
    seed.forEach(validateSeedEntry)
    await db.transaction(em => upsertValidators(em, seed.map(genesisToRow)))
    return { reseeded: true, count: ..., source: "genesis" }
}
```

**Safety guarantees**:

| State | Action |
|---|---|
| `count > 0` | no-op (never overwrite dynamic stakers / resurrect unstaked) |
| `count = 0` + snapshot has `validators.jsonl` | reseed from snapshot, any block height |
| `count = 0` + no snapshot + `block = 0` | reseed from `genesis.validators[]` (cold-start dev) |
| `count = 0` + no snapshot + `block > 0` | **refuse to boot** with remediation |
| `count = 0` + nothing usable | throw with operator-actionable message |

The "no auto-genesis past block 0" rule is what makes this safe for
mainnet: a wiped validators table at block N requires a real snapshot
to recover from, not a silent revert to the founders.

**Effect**: the previously silent failure mode (empty validators →
silent quorum death) self-heals at boot when a snapshot is available;
truly unrecoverable state fails loud with the remediation command
embedded in the error message.

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
