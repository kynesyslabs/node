# DEM-771 — Make node start/restart smooth: design

Author: shitikyan
Date: 2026-06-16
Status: Proposal (no code merged)

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

### 4.1. Idempotent re-seed on boot

**File**: new `src/libs/blockchain/routines/ensureValidatorSeed.ts`.
**Wired into**: `src/index.ts` immediately after `findGenesisBlock()`.

```ts
export async function ensureValidatorSeed(genesisData: any): Promise<void> {
    const count = await Validators.count()
    if (count > 0) return            // healthy

    const seed = (genesisData?.validators ?? []) as GenesisValidatorSeed[]
    if (seed.length === 0) return    // nothing to seed; falls through to 4.2

    log.warning(
        `[BOOT] validators table empty; re-seeding ${seed.length} entries from genesis.json`,
    )
    const db = (await Datasource.getInstance()).getDataSource()
    await db.transaction(async em => {
        await upsertValidators(em, seed)     // ON CONFLICT (address) DO NOTHING
    })
}
```

**Safety**: the gate `count > 0` means we never resurrect addresses
that legitimately unstaked — if the dynamic set has even one entry, we
leave the table alone. We only re-seed when the table is fully empty,
which is unambiguously a broken state.

**Effect**: the failure mode we hit today self-heals at boot. No
operator action required.

### 4.2. Boot self-check (fail loud when unrecoverable)

After `ensureValidatorSeed()`:

```ts
const count = await Validators.count()
if (count === 0) {
    throw new Error(
        `[BOOT] validators table empty and genesis.json carries no ` +
        `validator set; chain cannot reach consensus. Either restore ` +
        `data/snapshot/ from a healthy peer and re-run './run --reset', ` +
        `or fix data/genesis.json.`,
    )
}
```

This only fires when 4.1 had nothing to seed — i.e. the chain is
genuinely unrecoverable from local data alone. The error message names
the remediation.

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

1. PR-1: `ensureValidatorSeed` + `upsertValidators` helper + unit
   tests. Wire into `src/index.ts`. Behind no flag — the gate
   (`count === 0`) is already conservative.
2. PR-2: boot self-check throw (section 4.2). Trivial.
3. PR-3: `wipe-and-reboot.sh --devnet` + `./run --reset` /
   `./run --docker --reset` dispatch.

Each PR is independently testable and revertible. Order matters only
for the user-visible message: ship 4.1 first so the self-check in 4.2
never fires for the failure mode we already know how to fix.
