# Fork activation rehearsal: signatureDomain and web2ProofBinding

`rehearsal.sh` schedules both forks on a local 4-validator devnet, walks the
chain across the activation height, and checks what each node accepts, refuses
and signs before, at and after it. It also shows what a validator that never
learned the schedule does to the rest of the network.

One command, its own network, torn down on exit.

```bash
./testing/forks/rehearsal.sh
```

It exits 0 when every check passed, 1 when a check failed, 2 when the host or
the setup could not run it. The last line before the teardown is the check
count, for example `summary: 50 checks passed, 0 failed`.

## Running it

Needs docker with compose v2, bun, jq and rsync on the host. About 10 minutes
at the defaults: 30 blocks of 10 seconds plus the node restarts, once the
image exists. The first build takes a few minutes on top.

The host is shared, so the script refuses to start when less than 4 GB of RAM
is available, when the 1-minute load is above the core count, when less than
10 GB of disk is free, or when one of its host ports is taken
(53551-53558, 3005-3008 and the Postgres port). Containers are capped (4 GB
per node, 1 GB for Postgres), the database lives in tmpfs, and the stack is
removed with `docker compose down -v` on every exit path. Nothing uses a named
volume.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACTIVATION_HEIGHT` | 30 | height both forks are scheduled at |
| `CHAIN_ID` | 31337 | genesis `properties.id`, the chain the signatures bind to |
| `CONSENSUS_TIME` | 10 | seconds per block |
| `PG_PORT` | 55433 | host port for the devnet Postgres (5432 is usually taken) |
| `IMAGE` | `forkrehearsal-node:src` | node image tag |
| `REBUILD` | 0 | rebuild the image even if the tag exists; set after changing `src/` |
| `NODE_MODULES_FROM` | unset | an installed `node_modules` to layer onto the bun image instead of running `testing/devnet/Dockerfile` (that one needs apt and `bun install`) |
| `NODE_MEM`, `PG_MEM` | 4g, 1g | container memory caps |
| `KEEP` | 0 | leave the network running afterwards, for debugging |
| `RUN_DIR` | `testing/runs/fork-rehearsal-<time>` | where everything below is kept (git-ignored) |

Per run directory:

- `logs/rehearsal.log` host checks, image, setup; `logs/scenario.log` the whole
  scenario output; `logs/node-N.log` each node's log, collected before the
  teardown; `logs/docker-events.log` every start, die (with exit code) and oom
  of the containers.
- `steps/NN-<step>.log` one log per step, and `steps/NN-<step>.<label>.json`
  the exact response behind each recorded line.
- `data/` the generated identities, genesis copies and compose override.
  Identities are throwaway devnet keys.

The identities, the peer list and one genesis file per node are generated per
run, so a run never reuses or touches `testing/devnet`'s own files.

## What it proves

Every line is a check; the scenario is `rehearsal.ts`.

1. **Configuration.** All 4 nodes report `signatureDomain` at the scheduled
   height and the chain id through `getNetworkInfo`, and log both forks as
   loaded. The node's own loader, fed the same genesis, reports both forks
   inactive at H-1 and active at H. `tlsnProofEnforcement` stays unscheduled
   when genesis does not name it.
2. **Before the height.** A legacy-signed native transfer is accepted and lands
   in one block on every node, below H. The same transaction signed with the
   domain preimage is refused at `confirm`.
3. **The activation block.** At tip H-1 `getNetworkInfo` already reports the
   fork active, because it answers for the block a new transaction would land
   in. At that tip the legacy-signed copy is refused and the domain-signed copy
   is accepted and included in block H.
4. **After the height.** A client that follows `getNetworkInfo` signs the
   domain preimage on its own. Legacy is refused, a domain signature bound to
   another chain id is refused, the correctly bound one is accepted and
   included.
5. **Agreement.** Block hashes are identical on all 4 nodes from H-3 to the
   tip, `getLastBlock` agrees, balances and nonces are identical, and the
   sender's nonce shows that exactly the accepted transfers landed and no
   refused one did.
6. **A validator without the schedule.** Node 4's genesis loses both fork
   entries and the node restarts. Observed and checked: its bootstrap finds the
   genesis hash different from its peers' and overwrites its own genesis file
   with a peer's, but the running process keeps the schedule it read at boot.
   It refuses the domain-signed transfer the others accept and accepts the
   legacy-signed one the others refuse. The other validators refuse its
   candidate blocks, the blocks it was drawn into carry 3 signatures and none
   is its own, and its stall watchdog ends the process after three of them.
   Its chain state still follows the quorum.
7. **Recovery.** The engine restarts the node, it reads the genesis it
   downloaded, reports the fork at H, catches up, block hashes and balances
   agree again on all 4 nodes, and its signature is back in the latest blocks.
8. **Nothing else moved.** Nodes 1-3 were never restarted and no container was
   killed for memory.

## What it does not prove

- **A real older binary.** Node 4 runs the same code with a genesis that
  schedules nothing, which is what a node from before the forks sees for the
  signature rule. Running a build from before the forks would also bring every
  other consensus change merged since (fee derivation, shard selection, stall
  detection), so a split could not be pinned on the forks. The honest version
  is "previous release tag against the current one" on a testnet, with the
  schedule on both.
- **web2ProofBinding end to end.** The proof is fetched from the web (a
  gist, a post), which a hermetic devnet cannot serve. What is covered is that
  the field name is right, every node loads it at H, and the gate flips at H.
  The proof verifier reads the fork at the chain tip rather than at the tip
  plus one (which `signatureDomain` does), so the first block that rejects the
  legacy shape is probably H+1, not H. Not rehearsed.
- **tlsnProofEnforcement beyond its default.** Unscheduled means a TLSNotary
  identity claim is accepted on its structure alone, as before. Scheduling it
  is a separate decision.
- **The wallet extension.** It is not in this repository. See the runbook.
- **A legacy transaction that sits in a mempool across H.** Admission refuses
  legacy signatures from tip H-1 on, so a transaction admitted earlier and not
  yet included when H arrives is judged by the new rule at block H. Not
  exercised.
- **A fresh node syncing the history across H.** Block sync does not re-verify
  transaction signatures (step 6 shows it), so this is not expected to matter,
  but it was not run.

## Operator runbook for a testnet activation

### Genesis fields

In `data/genesis.json`, identical on every validator and RPC node:

```json
{
  "properties": { "id": 1 },
  "forks": {
    "signatureDomain":  { "activationHeight": 123456 },
    "web2ProofBinding": { "activationHeight": 123456 }
  }
}
```

- `properties.id` must be an integer. A node refuses to boot when
  `signatureDomain` is scheduled and `properties.id` is missing, because the
  signature binds to it. Pick an id that is unique to the network: two
  networks sharing one id give each other's signatures no protection.
- `activationHeight` is a non-negative integer, or `null` for never. A fork is
  active for every block at or above it. Both forks default to `null`, so a
  genesis that does not name them changes nothing.
- The fork entries are part of the genesis hash that peers compare at start-up.
  Every node must carry the same entries.

### Choosing the height

H = current tip plus the rollout window, in blocks. At 10 seconds a block that
is 360 blocks per hour. The window has to cover the slowest of: every validator
and RPC node restarted on the new genesis, and the SDK and wallet releases out
with their users. A day (8640 blocks) is comfortable; the rehearsal uses 30
because everything is local. Nothing is lost by choosing later, and nothing can
be undone after block H is final.

`web2ProofBinding` can use the same height. The SDK already signs the bound
shape on every network, and the node accepts both shapes until the height, so
clients migrate without a flag day.

### Order of upgrades

1. **SDK.** A release that builds the domain preimage and picks the legacy or
   the domain one from `getNetworkInfo`. The version pinned here (4.0.17) does,
   and the rehearsal confirms it: before H it signs legacy, after H it signs
   the domain preimage with no code change in the caller. Services, bots and
   dApps must be on it before H; anything older produces legacy signatures
   that are refused from H.
2. **Wallet extension.** It has to sign through the SDK's signer (or implement
   `txSignaturePreimage` byte for byte and read `getNetworkInfo`) and must not
   hard-code either preimage: the node refuses the domain preimage before H
   just as it refuses the legacy one after. This could not be verified from this
   repository. Test the build against a devnet with the forks scheduled, for
   example this rehearsal with `KEEP=1`, before announcing a height.
3. **Nodes.** Put the `forks` entries in `data/genesis.json` and restart every
   validator and every RPC node, all of them before block H. An RPC node on the
   old schedule refuses domain-signed transactions at `confirm`, so its users
   see failures at H.
4. Announce the height once 1-3 are done, not before.

The first two can ship long before the third: a client that follows
`getNetworkInfo` behaves exactly as before until the node reports the fork.

### Before the height, on each node

- The log has `[FORKS] Loaded fork "signatureDomain" with activationHeight=H`
  and the same line for `web2ProofBinding`. `getNetworkInfo` does not report
  `web2ProofBinding`; the log line is the only runtime evidence.
- `getNetworkInfo` returns `forks.signatureDomain.activationHeight` equal to H
  and the expected `chainId`.
- The `getGenesisDataHash` node call returns the same value on every node.

### At the height

- At tip H-1 `getNetworkInfo` reports `activated: true`. Clients that cached the
  earlier answer keep it for up to 30 seconds (the SDK re-asks while a fork is
  pending) and sign legacy in that window, so expect a short burst of
  `[Tx Validation] [SIGNATURE ERROR] Transaction signature verification failed`
  from long-lived clients, which clears by itself.
- A validator on the wrong schedule shows up as
  `Hash does not correspond to our candidate block` and
  `[STALL DETECTION] Drawn into the shard ... our signature is missing` in its
  log, and as 3 signatures per block instead of 4 in the stored blocks.

### Failure modes seen

| What happened | What it looked like | What to do |
| --- | --- | --- |
| Domain signature before H, or legacy after H | refused at `confirm` with the signature error above; nothing is stored | the client signs from `getNetworkInfo`, never from a constant |
| Domain signature bound to another chain id | same signature error | the id in the client comes from `getNetworkInfo`, and must equal `properties.id` |
| A validator's genesis differs in `forks` | `Genesis data hash does not match` at start-up; the node downloads a peer's genesis and overwrites `data/genesis.json`, then keeps running on the schedule it read at boot | after fixing the file, restart that node once more. The overwrite makes the second boot correct |
| That validator is left running | admits legacy, refuses domain, its blocks are refused by the others, 3 signatures per block. A 3-of-4 quorum survives one such node; two would stall it (not run). Its state still follows the chain | restart it |
| The stall watchdog ends the process | exit code 0 after three drawn shards without its signature | the supervisor must restart on exit code 0. A policy that restarts only on failure leaves the node down |
| The stale validator admitted a legacy transaction | that transaction sat in its own mempool and kept spoiling its candidate blocks | it was gone after the restart (the mempool table was empty), nothing to clean by hand |
| Devnet start-up | nodes exit when a peer is not answering yet and the engine restarts them; they settle within a minute. The script starts node 1 first | none on a real network, where nodes start in their own time |

Block sync applies blocks that carry a quorum of validator signatures without
re-checking the transactions' own signatures, which is why a node on the wrong
schedule still holds the right chain state while being unable to vote on it.

### Postponing or reverting

Before block H: set the new height (or `null`) in `data/genesis.json` on every
node and restart them all before the old H. The hash changes, so nodes with the
old and the new value cannot pair until they agree. After block H is final
there is nothing to undo short of a chain-level decision.

## Results of the recorded run

Run on 2026-10-14 from `origin/stabilisation` at `52e2e569` with the SDK
pinned in `package.json` (4.0.17), `oven/bun:latest` (bun 1.4.0), 4
validators, forks at 30, chain id 31337, 10 seconds per block. About 10
minutes from start to teardown.

**`summary: 50 checks passed, 0 failed`.** The network was too slow here for
the apt and `bun install` steps of `testing/devnet/Dockerfile`, so that path
was not run. The image was built the way `NODE_MODULES_FROM` builds it (this
tree plus an installed `node_modules` on `oven/bun:latest`); that branch of
the script was run separately with `IMAGE_ONLY=1` and produced a working
image.

Every response below is the exact text the node returned.

### 1. Configuration

`getNetworkInfo` on node 1 at tip 2:

```json
{"forks":{"osDenomination":{"activationHeight":0,"activated":true,"currentHeight":2},
 "signatureDomain":{"activationHeight":30,"activated":false,"currentHeight":2}},
 "chainId":31337,"nodeVersion":{"name":"demos-node-software","version":"0.9.8","commit":null,"commitShort":null,"commitMessage":null,"branch":null,"dirty":false,"builtAt":null}}
```

All four nodes logged `[FORKS] Loaded fork "signatureDomain" with
activationHeight=30` and the same for `web2ProofBinding`. The loader, fed the
same genesis: both forks `[inactive at 29, active at 30]`.
`tlsnProofEnforcement`: `activationHeight` is `null` in the defaults and the
gate reports it inactive at every height. Its default behaviour is therefore
the legacy one: a TLSNotary identity claim is accepted on its structure alone.

### 2. Before the height (tip 2, forks at 30)

| Transaction | Node response | Result |
| --- | --- | --- |
| domain-signed transfer | at `confirm`: `Error: [Confirm] Transaction is not valid: [Tx Validation] [SIGNATURE ERROR] Transaction signature verification failed` | refused |
| legacy-signed transfer (same content, same hash) | `{"result":200,"response":{"message":"Transaction applied, waiting for confirmation"},"require_reply":false,"extra":{"confirmationBlock":3,"hash":"de86a4fae2b6b268c0ac97085068176df3d5810b38fbcdaac14e5537ed6ef1e1","disposition":"mempool"}}` | accepted, block 3 on all 4 nodes |

### 3. The activation block (tip 29)

`getNetworkInfo` signatureDomain at tip 29:
`{"activationHeight":30,"activated":true,"currentHeight":29}`.

| Transaction | Node response | Result |
| --- | --- | --- |
| legacy-signed transfer | same signature error as above | refused |
| domain-signed copy of it | `{"result":200,"response":{"message":"Transaction applied, waiting for confirmation"},"require_reply":false,"extra":{"confirmationBlock":30,"hash":"19ea2b26ab11541bc8ec88b79d130ce18d8a9374ab6c1b5414731a8933f7b70d","disposition":"mempool"}}` | accepted, **block 30** on all 4 nodes |

### 4. After the height (tip 31)

| Transaction | Node response | Result |
| --- | --- | --- |
| legacy-signed transfer | same signature error | refused |
| domain-signed, bound to chain id 31338 | same signature error | refused |
| domain-signed, signed by the SDK from `getNetworkInfo` (chain id 31337) | `{"result":200,"response":{"message":"Transaction applied, waiting for confirmation"},"require_reply":false,"extra":{"confirmationBlock":32,"hash":"511e5bc32b9743ed58d2dc78989b3f0b66f56e556374ae635dcae6c753df9350","disposition":"mempool"}}` | accepted, block 32 on all 4 nodes |

The SDK's own signature was byte-identical to the one built from the node's
`txSignaturePreimage`.

### 5. Agreement across the height

Blocks 27 to 33: the same hash on all four nodes for every block;
`getLastBlock` on each node returns
`33:5ca1dd3944b31e0ad5a15b04474f121ce050ca8759762a218bb5f8972368e96a`. Each of
those blocks carries 4 validator signatures. The sender's balance and nonce
are `999999999999999988000000000:3` on every node (three transfers, nothing
refused landed) and the recipient holds exactly 3000000000.

### 6. A validator that boots without the schedule

Node 4's genesis lost both fork entries and the node was restarted at tip 35.

- Its log: `Genesis data hash does not match` (the entries are part of the hash),
  then it fetched a peer's genesis and rewrote `data/genesis.json`, which now
  has `signatureDomain` and `web2ProofBinding` at 30 again.
- Its own `getNetworkInfo` still said
  `{"activationHeight":null,"activated":false,"currentHeight":35}`.
- The same domain-signed transfer: node 4 refused it with the signature error;
  node 1 accepted it (`confirmationBlock":36`, block 36 on all four nodes).
- The same legacy-signed transfer from another account: node 1 refused it,
  node 4 accepted it (`"confirmationBlock":36,"hash":"7b4f22b25105ba06568c657bd0a493bc0d5c0f17f73405d63f23c61df22324c1"`).
  It landed in no block on any node.
- Node 4's candidate blocks were refused (`Hash does not correspond to our
  candidate block`, 9 refusals) and it logged
  `[STALL DETECTION] Drawn into the shard for block N but our signature is
  missing (k/3)` for blocks 37, 38 and 39. Those three blocks were signed by
  the other 3 validators and none carries node 4's key. After the third:
  `Missed 3 consecutive shard selections, last at block 39: the node appears
  stalled - exiting for log investigation`, exit code 0.
- Block 36, with the domain-signed transfer, was stored on node 4 anyway, and
  its balances matched the quorum's.

### 7. Recovery

The engine restarted node 4 (a clean exit, so a restart policy such as
`unless-stopped` brings it back). It logged `Loaded fork "signatureDomain"
with activationHeight=30`, reported the fork at 30, caught up, and blocks
34 to 43 have the same hash on all four nodes. Balances and nonces matched.
Blocks 42 and 43 carry 4 signatures, node 4's included. The legacy-signed
transfer node 4 had admitted was gone from its mempool table. Peers still
refused 6 more of node 4's candidate blocks in the rounds around the catch-up
(15 in total against 9 before it) before the signatures came back.

### 8. Container health

Nodes 1-3 were not restarted by the engine after the scenario started and no
container was killed for memory. Node 4: one engine restart, the stall exit.
Peers occasionally make a node exit during the first minute (the devnet start-up
race; the script starts node 1 first), which is why the counts are compared
from the start of the scenario.

### What the run left behind

Zero containers, volumes and networks of the `forkrehearsal` project after the
teardown. The image `forkrehearsal-node:src` stays for the next run.
