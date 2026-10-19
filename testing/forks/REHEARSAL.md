# Fork activation rehearsal: signatureDomain and web2ProofBinding

`rehearsal.sh` schedules both forks on a local 4-validator devnet, walks the
chain across the activation height, and checks what each node accepts, refuses
and signs before, at and after it. It has two modes:

- **Fresh** (the default): the schedule is in the genesis file from block 0.
  This mode also shows what a validator on the wrong schedule does to the rest
  of the network.
- **Upgrade path** (`UPGRADE_PATH=1`): the chain starts with no schedule and no
  chain id, runs to block 10, and then the schedule is added to the genesis
  file of every node, which are restarted twice before the height. This is what
  a testnet activation is.

One command, its own network, torn down on exit.

```bash
./testing/forks/rehearsal.sh                 # fresh
UPGRADE_PATH=1 ./testing/forks/rehearsal.sh  # upgrade path
```

The older harness in `testing/forks/rehearsal/` rehearses the denomination fork
and uses the same host ports, so the two cannot run at the same time. The
generic runbook for scheduling a fork is `forking/RUNBOOK_FORK_ACTIVATION.md`;
this document adds what the rehearsal found for these two forks.

## What the upgrade-path mode found

The first version of this rehearsal only started chains that had the schedule in
block 0, and its runbook told operators to add the schedule to the genesis file
of the running testnet and restart. Run against the tree as it was, the
upgrade-path mode shows that does not work:

```
[10:46:03] [INFO]    [FORKS] Loaded fork "signatureDomain" with activationHeight=40
[10:46:03] [INFO]    [FORKS] Loaded fork "web2ProofBinding" with activationHeight=40
[10:46:03] [ERROR]   Genesis data hash does not match
[10:46:03] [WARNING] Expected: 1042ec76ba8b1301... Got: 7fcd880cd7aa2460...
[10:46:03] [DEBUG]   Downloaded genesis data with hash: 7fcd880cd7aa2460...
```

(node 1, first restart, unfixed tree; the same four lines on every node.)

After the first restart all four genesis files were back to the version stored
at chain creation (no `forks` entries for the new forks, no `properties.id`),
the second restart loaded no fork at all, `getNetworkInfo` reported
`signatureDomain` unscheduled with `chainId: null`, and the chain crossed height
40 with the legacy rules. Checks that failed on the unfixed tree: the file still
carries the schedule after bootstrap, no hash mismatch, second restart loads
both forks, `getNetworkInfo` after the second restart, and every
activation-height check after that. (The upgrade-path scenario fails on a tree
without the fix, on purpose.)

Cause, from the code: a node computes its own genesis data hash from
`data/genesis.json`, but a peer answers `getGenesisDataHash` and `/genesis` from
the genesis block stored in its database when the chain was created, which is
never refreshed. The fork entries and `properties.id` were part of that hash,
so an edited file never matched anybody's stored block, and the original
mismatch handler overwrote the file from the peer. The running process keeps what it
read at boot, so the first boot after the edit works and the next one
silently does not. `forking/RUNBOOK_FORK_ACTIVATION.md` used to claim the
opposite ("Only the `forks` block additions are hash-invariant"); it is
corrected.

### The fix

The hash that peers advertise and the data `/genesis` serves are left exactly
as they were: the full hash of the genesis block stored at chain creation, with
the original normalisation. A node on a build without this change therefore
keeps comparing the same hash against the same anchors, and the two builds can
run side by side. Only what the REQUESTING node does with a mismatch changed
(`genesisMismatch.ts`, wired in `peerBootstrap.ts`):

1. Its own two hashes are computed from the file: the full one, and a core one
   that leaves out `forks` and `properties.id`.
2. A peer's advertised hash equal to the full one: match, nothing to do.
3. Otherwise `/genesis` is downloaded and must hash, in full, to what the peer
   advertised. If it does not, the node throws: the peer's two answers disagree.
4. If the core hash of the served data equals the node's own core hash, the
   difference is only the schedule or the chain id: the file is kept and a
   warning says so.
5. Otherwise the file is replaced with the served data, with the local `forks`
   and `properties.id` carried over, and the replacement is logged naming what
   was carried over.

`forks` and `properties.id` are the two things an operator adds to the file of a
running chain, and neither is covered by any block after block 0, which is why
they are the only exclusions. The unit tests (`testing/genesis/genesisMismatch.test.ts`)
run the real old and the real new hash functions against both the production
and the devnet genesis for the four pairings of builds: new against old, old
against new, new against new with the same schedule, and new against new with
different schedules.

**What decides which peer is right.** A node with a stored block 0 from an earlier
boot treats that block's hash as the authority: if its file already hashes to
it, a peer advertising another hash is ignored with a warning and nothing is
downloaded; if its file differs, only genesis data hashing to the stored block's
hash is accepted, anything else is refused with both hashes in the error. A
node with no such block (empty database) has no authority, so the first peer's
genesis is taken as before unless `EXPECTED_GENESIS_HASH` pins the full hash,
in which case anything else is refused. The advertised hash must be a sha256 hex
string, the download is capped at 10 seconds and 2 MB, and the file is replaced
through a temporary file that is verified before the rename.

**Why not refresh the stored genesis block from the file:** rewriting block 0's
stored content on every node changes what `/genesis` serves to joining nodes.

**Schedule agreement is a separate check.** `getNetworkInfo` reports every
registered fork (seven at present) with its activation height, the chain id, and
`forkScheduleDigest`: the sha256 of the scheduled forks (activation heights and
payloads, descriptions left out) and the chain id, with sorted keys. At
bootstrap each peer's digest is compared with the local one. A difference logs
one `FORK SCHEDULE MISMATCH` line carrying both digests and naming the forks
whose heights differ; when only a scheduled fork's payload or the set of
scheduled forks differs, the line says so instead. A peer on an older build,
which publishes no digest, is compared by activation heights and chain id alone,
and is skipped with a debug line only when it reports no fork data at all. The extra keys are additive: the SDK
reads only the fork entries it knows.

**A peer that is still booting is not a mismatch.** The RPC server starts before
the fork configuration is read from genesis, so a booting peer used to answer
`getNetworkInfo` with the code's defaults (every fork unscheduled). It now
answers 503 `STATE_NOT_READY` until the fork configuration and the chain id are
loaded; bootstrap retries a few times and then compares later instead of
warning.

**The comparison keeps running.** After block insertion the node repeats it
against its peers every 100 blocks, every 10 blocks once the tip is within 50
blocks of the nearest scheduled height, and at error level inside that window.
It only reports.

**Decision for the owner: should a persistent mismatch stop the node?** No hard
stop was added. The two risks pull in opposite directions:

- *Without a stop*, a node that missed the genesis edit pairs and splits at the
  height, with log lines as the only warning. A minority node splits silently.
- *With a stop at bootstrap or in the periodic check*, a rolling genesis edit
  becomes impossible or risky, because peers legitimately disagree while the
  edit rolls out, and a stop that fires on a busy network can remove validators
  and cost liveness at the worst moment.

A stop limited to the last blocks before a scheduled height, or to a digest that
has disagreed with a majority of peers for a number of consecutive checks, would
sit between the two; that is for the owner to choose, and nothing here decides it.

**The build has to be on every node before the genesis edit.** A node without it
still overwrites an edited file and still drops the schedule.

### A new node on a chain whose file was edited

Block 0 embeds the raw genesis JSON (`chainGenesis.ts`, `extra.genesisData`) and
its hash feeds the common validator seed. A node with an EMPTY database that
creates its chain from the edited file therefore gets a block 0 different from
the network's, and fast sync refuses the peers (`Sync.ts`,
`verifyLastBlockIntegrity`). The procedure for such a node (also a node whose
database was wiped): boot it on the UNEDITED genesis first, let block 0 be
stored, and only then add the `forks` entries and `properties.id` and restart.
A node that has done this anyway refuses to continue at bootstrap with an
error naming the cause, because its stored block 0 hashes differently from what
its peers advertise. The upgrade-path mode does not cover this, since every node there has a database
from before the edit.

## Running it

Needs docker with compose 2.24 or newer (the override uses `!override`), bun,
jq and rsync on the host. About 10 minutes in either mode at the defaults, once
the image exists; the first build takes a few minutes on top.

The host is shared, so the script refuses to start when less than 8 GB of RAM
is available, when the host is swapping, when the 1-minute load is above the
core count, when less than 10 GB of disk is free, or when one of its host ports
is taken (53551-53558, 3005-3008 and the Postgres port). Containers are capped
(4 GB per node, 1 GB for Postgres), the database lives in tmpfs, and the stack
is removed with `docker compose down -v` on every exit path. Nothing uses a
named volume.

Exit status: 0 every check passed; 1 a check failed; 2 the host or the setup
could not run it (including any command that failed during setup); 3 fewer
checks ran than the scenario has, or the teardown left containers, volumes or
networks behind.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UPGRADE_PATH` | 0 | 1 selects the upgrade-path mode |
| `UPGRADE_LEAD` | 30 | blocks between the genesis edit and the height in that mode |
| `ACTIVATION_HEIGHT` | 30 | height both forks are scheduled at from block 0 (fresh mode) |
| `CHAIN_ID` | 31337 | genesis `properties.id`, the chain the signatures bind to |
| `CONSENSUS_TIME` | 10 | seconds per block |
| `PG_PORT` | 55433 | host port for the devnet Postgres (5432 is usually taken) |
| `IMAGE` | `forkrehearsal-node:<git sha>[-dirty-<hash>]` | node image; rebuilt when the tag for the current tree is missing |
| `REBUILD` | 0 | rebuild the image even if the tag exists |
| `NODE_MODULES_FROM` | unset | an installed `node_modules` to layer onto the bun image instead of running `testing/devnet/Dockerfile` (that one needs apt and `bun install`) |
| `IMAGE_ONLY` | 0 | build the image and stop |
| `NODE_MEM`, `PG_MEM` | 4g, 1g | container memory caps |
| `KEEP` | 0 | leave the network running afterwards, for debugging |
| `RUN_DIR` | `testing/runs/fork-rehearsal-<time>` | where everything below is kept (git-ignored) |

Per run directory:

- `logs/rehearsal.log` host checks, image, setup; `logs/scenario.log` the whole
  scenario output; `logs/node-N.log` each node's log, collected before the
  teardown; `logs/docker-events.log` every start, die (with exit code) and oom
  of the containers; `logs/teardown.log` the containers, volumes and networks
  of the project left after the teardown (all 0 on success).
- `steps/NN-<step>.log` one log per step, and `steps/NN-<step>.<label>.json`
  the exact response behind each recorded line.
- `data/` the generated identities, genesis copies and compose override.
  Identities are throwaway devnet keys.

The identities, the peer list and one genesis file per node are generated per
run, so a run never reuses or touches `testing/devnet`'s own files.

Only one rehearsal runs at a time: the script takes an exclusive lock
(`testing/runs/.fork-rehearsal.lock`) before anything else and holds it until
the teardown is done, and a second launch exits with status 2 and says so. All
published ports (the nodes' RPC, omni and signaling ports, and Postgres) are
bound to 127.0.0.1 only, and the scenario talks to 127.0.0.1. The `http://node-N:port`
URLs in the generated genesis and peer list are the nodes' addresses on the
project's private docker network, between containers, so they cannot be loopback
addresses and plain http is what a hermetic local devnet uses. The image tag
folds in the content of untracked files under `src` and `testing/devnet`, so
editing one of them is never served from an older image.

## What it proves

Every line is a check; the scenario is `rehearsal.ts`.

**Upgrade-path mode only, before the common steps**

- *U1.* The chain starts with every node reporting `signatureDomain`
  unscheduled and `chainId: null`, reaches block 10, and blocks 8 to 10 carry
  all four validator signatures.
- *U2.* `properties.id` and both activation heights (tip + `UPGRADE_LEAD`) are
  written into every node's genesis file, and all four nodes are restarted,
  twice. After each restart: peer bootstrap completes, every node logs both
  forks loaded at the height, every genesis file still carries the id and both
  heights after bootstrap, every node logs that the peers' genesis differs from
  its own only in the schedule and chain id and keeps its file, none replaces
  its file, every node still advertises the hash of the genesis it was created
  with (the old-style hash, which a node without the change compares against),
  and `getNetworkInfo` reports the height and the chain id. Both restarts finish
  before the height, and blocks keep carrying four signatures.

**Both modes**

1. *Configuration.* All 4 nodes report `signatureDomain` and `web2ProofBinding`
   at the height and the chain id, and log both forks as loaded. The node's own
   loader, fed the same genesis, reports both forks inactive at H-1 and active
   at H. All four nodes report all seven forks and one and the same schedule
   digest. `tlsnProofEnforcement` stays unscheduled when genesis does not name it.
2. *Before the height.* A legacy-signed native transfer is accepted and lands
   in one block on every node, below H. The same transaction signed with the
   domain preimage is refused at `confirm`.
3. *The activation block.* At tip H-1 `getNetworkInfo` already reports the
   fork active, because it answers for the block a new transaction would land
   in. At that tip the legacy-signed copy is refused and the domain-signed copy
   is accepted and included in block H.
4. *After the height.* A client that follows `getNetworkInfo` signs the domain
   preimage on its own. Legacy is refused, a domain signature bound to another
   chain id is refused, the correctly bound one is accepted and included.
5. *Agreement.* Block hashes are identical on all 4 nodes from H-3 to the tip,
   `getLastBlock` agrees, balances and nonces are identical (read while all
   four tips agreed and held still), and the sender's nonce shows that exactly
   the accepted transfers landed and no refused one did.

**Fresh mode only**

6. *A validator without the schedule.* Node 4's genesis loses both fork entries
   and the node restarts. Its bootstrap pairs normally (the peers' genesis differs only in the
   schedule, so its file is kept) and logs `FORK SCHEDULE MISMATCH` against its
   peers, with its digest and theirs; its `getNetworkInfo` digest differs from the
   quorum's. It
   refuses the domain-signed transfer the others accept and accepts the
   legacy-signed one the others refuse. Peers refuse its candidate blocks, the
   blocks it was drawn into carry 3 signatures and none is its own, and its
   stall watchdog ends the process after three of them.
7. *Recovery.* Left alone, nothing heals it: the engine restarts it from the
   same file and it warns again. The operator corrects the file and restarts the
   node; it then loads the schedule, reports the quorum's digest, catches up,
   block hashes and balances agree again on all 4 nodes, and its signature is back in the latest blocks.
8. *Nothing else moved.* No container was restarted by the engine or killed for
   memory beyond what the scenario issued.

## What it does not prove

- **A real older binary.** Node 4 runs the same code with a genesis that
  schedules nothing, which is what a node from before the forks sees for the
  signature rule. Running a build from before the forks would also bring every
  other consensus change merged since (fee derivation, shard selection, stall
  detection), so a split could not be pinned on the forks. The stronger version
  is "previous release tag against the current one" on a testnet, with the
  schedule on both.
- **The `web2ProofBinding` gate.** It was loaded only: the field name is right,
  every node loads it at H, `getNetworkInfo` reports it, and the loader's gate
  flips at H. The rule itself was not exercised end to end, because the proof is
  fetched from the web (a gist, a post), which a hermetic devnet cannot serve.
  A unit test drives `verifyWeb2Proof` itself across the boundary with the
  parser and the signature pool replaced. The gate used to read the node-local
  tip, while `signatureDomain` gates at tip + 1, so the first block that
  rejected the legacy shape was H+1; the gate now judges at tip + 1,
  which changes behaviour at the activation boundary only (nothing changes
  while the fork is unscheduled). **The gate is admission-only.** It is consulted
  when a web2 proof is verified for the mempool. The Telegram path returns
  before it, so Telegram proofs are not judged by the gate at all, and nothing
  judges a proof at an explicit block height at validation or apply time, unlike
  `signatureDomain` (`txSignatureContext(block.number)`). A legacy-shaped proof
  admitted by a node whose tip lags, or included by a hostile proposer, can still
  land after H. A validation-time check is the recommended follow-up; it was not
  implemented here.
- **tlsnProofEnforcement beyond its default.** Unscheduled means a TLSNotary
  identity claim is accepted on its structure alone, as before. Scheduling it
  is a separate decision.
- **The wallet extension.** It is not in this repository. See the runbook.
- **A legacy transaction that sits in a mempool across H.** Admission refuses
  legacy signatures from tip H-1 on, so a transaction admitted earlier and not
  yet included when H arrives is judged by the new rule at block H. Not
  exercised.
- **A fresh node syncing the history across H.** Not run. Step 6 suggests block
  sync does not matter here (node 4 stored a block holding a transaction its own
  rules call invalid and kept following the chain), but that is an inference
  from behaviour; the sync code was not read for it.
- **A mixed fleet during the rollout of the build itself** (some nodes with it,
  some without). The advertised hash and `/genesis` did not change, so the two
  builds compare against the same anchors; the four pairings are unit-tested
  with the real old and new hash functions, but no run mixed two builds.
- **The periodic schedule check near a height.** Unit-tested (when it is due,
  when it escalates, that it never throws); the rehearsal chain is too short to
  reach the 100-block cadence, and the 50-block window is not entered at the
  default heights.
- **The 503 while a node boots.** Unit-tested at the handler and in the bootstrap
  retry; the rehearsal does not poll fast enough to catch the window.

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
  networks sharing one id give each other's signatures no protection. The
  repository's `data/genesis.json` carries id 1.
- `activationHeight` is a non-negative integer, or `null` for never. A fork is
  active for blocks at or above it as judged by the node's gate: for both forks
  admission and `getNetworkInfo` answer for the next block, so they flip when
  the tip is H-1. Both forks default to `null`, so a genesis that does not name
  them changes nothing.
- The genesis data hash peers advertise still covers everything in the stored
  genesis block. A node on a build with the two-hash handling tolerates a file
  that differs from the stored one only in `forks` and `properties.id`.

### Choosing the height

H = current tip plus the rollout window, in blocks. At 10 seconds a block that
is 360 blocks per hour. The window has to cover the slowest of: every
validator and RPC node on the fixed build and restarted on the new genesis, and
the SDK and wallet releases out with their users. A day (8640 blocks) is
comfortable; the upgrade-path rehearsal uses 30 because everything is local.
The generic runbook asks for at least 600 blocks of lead. Nothing is lost by
choosing later, and nothing can be undone after block H is final.

`web2ProofBinding` can use the same height. The SDK builds the bound shape
unconditionally (read in `build/abstraction/Identities.js` of 4.0.17; not run
against a node here), and the node accepts both shapes until the height, so
clients should migrate without a flag day.

### Order of upgrades

1. **SDK.** A release that builds the domain preimage and picks the legacy or
   the domain one from `getNetworkInfo`. The version pinned here (4.0.17) does:
   in the rehearsal, before H it signed legacy and after H it signed the domain
   preimage with no change in the caller. Services, bots and dApps must be on it
   before H; anything older produces legacy signatures that are refused from H.
2. **Wallet extension.** It has to sign through the SDK's signer (or implement
   `txSignaturePreimage` byte for byte and read `getNetworkInfo`) and must not
   hard-code either preimage: the node refuses the domain preimage before H
   just as it refuses the legacy one after. This could not be verified from this
   repository. Test the build against a devnet with the forks scheduled, for
   example this rehearsal with `KEEP=1`, before announcing a height.
3. **Node build with the two-hash genesis handling, on every validator and RPC
   node.** Nothing about the schedule changes yet. Without it the next step does
   not stick. A node that is new or has an empty database follows the procedure
   in "A new node on a chain whose file was edited" above.
4. **Genesis edit.** Add the `forks` entries (and `properties.id` if the file
   has none) to `data/genesis.json` on every node and restart all of them, all
   before block H. An RPC node on the old schedule refuses domain-signed
   transactions at `confirm`, so its users see failures at H. A validator that
   misses it pairs normally and splits at H (below).
5. Announce the height once 1-4 are done, not before.

The first two can ship long before the rest: a client that follows
`getNetworkInfo` behaves exactly as before until the node reports the fork.

### Before the height, on each node

- The log has `[FORKS] Loaded fork "signatureDomain" with activationHeight=H`
  and the same line for `web2ProofBinding`.
- `getNetworkInfo` returns `forks.signatureDomain.activationHeight` and
  `forks.web2ProofBinding.activationHeight` equal to H, and the expected
  `chainId`.
- `getNetworkInfo` returns the same `forkScheduleDigest` on every node.
- The log has no `FORK SCHEDULE MISMATCH` line from boots after the last node
  was restarted. Lines from earlier boots are expected: while the nodes are
  restarted one after another the first ones up still see peers that have not
  been edited yet, and a peer whose RPC is up before it has loaded its own genesis
  answers 503 and is retried, not reported.
- `data/genesis.json` still carries the entries after the node has booted.

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
| Genesis edit on a build without the two-hash handling | `Genesis data hash does not match` on every node, the file overwritten with the stored version, the schedule gone at the next restart | the newer build on every node first (step 3) |
| Empty-database node booted on the edited file | a block 0 different from the network's; fast sync refuses its peers | boot it on the unedited genesis first, then add the schedule |
| `web2ProofBinding` legacy proof after H | can still land: the gate is admission-only | a validation-time check (follow-up); until then the height is a client deadline |
| A validator whose genesis lacks the schedule | pairs, logs `FORK SCHEDULE MISMATCH`, admits legacy, refuses domain, its candidate blocks are refused by the others, 3 signatures per block. A 3-of-4 quorum survives one such node; two would stall it (not run) | correct its file and restart it |
| The stall watchdog ends the process | exit code 0 after three drawn shards without its signature | see below |
| The wrong validator admitted a legacy transaction | that transaction sat in its own mempool and kept spoiling its candidate blocks | it was gone after the restart (the mempool table was empty), nothing to clean by hand |
| Devnet start-up | nodes exit when a peer is not answering yet and the engine restarts them; they settle within a minute. The script starts node 1 first | none on a real network, where nodes start in their own time |

**What happens to a wrong-schedule validator on testnet.** The root
`docker-compose.yml` runs the node with `restart: "no"` and a reaper service
that stops the rest of the stack when the node exits, so that an intentional
exit stays down with its logs intact. The stall watchdog's `process.exit(0)`
(`stallDetection.ts`) therefore leaves that validator DOWN, not restarted. The
devnet compose this rehearsal uses has `restart: unless-stopped`, so there the
engine restarts the node and it loops on the same file; the rehearsal's
recovery step is the operator correcting the file and restarting, which is what
testnet needs too, plus starting the stack again. A supervisor that restarts
only on failure is no help either: the exit code is 0.

Block sync applied a block holding a transaction the node's own rules call
invalid, so it looks as if blocks that carry a validator quorum are applied
without re-checking each transaction's signature (an inference from that one
observation). That is why a node on the wrong schedule still held the right
chain state while being unable to vote on it.

### Postponing or reverting

Before block H: set the new height (or `null`) in `data/genesis.json` on every
node and restart them all before the old H. Peers
still pair whatever the schedule says, because the advertised hash does not
change; `FORK SCHEDULE MISMATCH` (and the periodic `[FORK SCHEDULE]` lines near
the height) are the only sign. After block H is final there is nothing to undo short of a
chain-level decision.

## Results of the recorded runs

Both runs on a clean tree, SDK 4.0.17, `oven/bun:latest` (bun 1.4.0), 4 validators, chain id 31337, 10 seconds
per block, 2026-10-14. About 10 minutes each. The network was too slow here for
the apt and `bun install` steps of `testing/devnet/Dockerfile`, so that path was
not run; the image was built through `NODE_MODULES_FROM`.

| Mode | Command | Summary | Exit |
| --- | --- | --- | --- |
| fresh | `./testing/forks/rehearsal.sh` | `58 checks passed, 0 failed, 58 expected` | 0 |
| upgrade path | `UPGRADE_PATH=1 ./testing/forks/rehearsal.sh` | `48 checks passed, 0 failed, 48 expected` | 0 |

Teardown: `after teardown: 0 containers, 0 volumes, 0 networks of project
forkrehearsal` in both runs (`logs/teardown.log`).

Every response below is the exact text the node returned. The block and hash
numbers differ between runs; the shapes do not.

### Upgrade path (forks added to the running chain, height 40)

- Tip 10: `properties.id=31337` and both heights 40 written into all four genesis
  files; all four nodes restarted, twice. Before the edit every node reported
  `signatureDomain` `activationHeight: null` and `chainId: null`.
- After each restart, on every node: `Loaded fork "signatureDomain" with
  activationHeight=40`, the same for `web2ProofBinding`; for each peer
  `Peer http://node-1:53551 serves genesis data that differs from ours only in
  the fork schedule or chain id; keeping our data/genesis.json as it is`; no
  replacement of the file; the genesis file still carrying the id and both
  heights; `getNetworkInfo` reporting 40 and chain id 31337.
- The advertised hash is the old-style one. Before the edit the scenario
  computed the full hash of the unscheduled genesis the chain was created from
  (`5c1d1e05bfdc1f3f895eb87ff267c2071982a4e25ac23c521938ea0c498b209d`); after the
  first and after the second restart `getGenesisDataHash` on each of the four
  nodes returned exactly that value, although every node's file now holds the
  schedule. A node on a build without this change therefore still compares equal
  against all four.
- No `FORK SCHEDULE MISMATCH` line on any node in this run, including during the
  rolling restart. In the earlier run of the same scenario with the first
  design, nodes that came up first reported one because a peer that had not yet
  loaded its genesis answered with the code's defaults; the not-ready answer
  and the retry removed that. The 503 itself was not observed in the logs: the
  window is short and only covered by unit tests.
- Both restarts were done by tip 12 (height 40), blocks 14 and 15 carry 4
  signatures. All four nodes report all 7 forks and one schedule digest.
- Steps after that behave as in the fresh run below: legacy accepted in block
  16, tip 39 reports `{"activationHeight":40,"activated":true,"currentHeight":39}`,
  the legacy-signed copy is refused at `confirm` with the signature error, the
  domain-signed copy is accepted with `"confirmationBlock":40` and lands in
  block 40 on all four nodes, a later domain-signed transfer lands in block 42,
  blocks 37 to 43 have the same hash on every node and `getLastBlock` is
  `43:3877036af901e57795c563d3ed8c6dd1f6242152857e27f638f9fbe02def8c80` on each.
- Same scenario on a tree without the fix: every node logged
  `Genesis data hash does not match` on the first restart, all four files lost
  the schedule, the second restart loaded no fork, and the chain crossed height 40
  on the legacy rules (log lines above).

### Fresh (forks in block 0, height 30)

**1. Configuration.** `getNetworkInfo` on node 1 at tip 2 reports seven forks:
`osDenomination`, `gasFeeSeparation` and `nonceEnforcement` at 0 and active,
`signatureDomain` and `web2ProofBinding` at 30 and not yet active,
`tlsnProofEnforcement` and `atomicWork` unscheduled (`"activationHeight":null`),
`"chainId":31337` and `"forkScheduleDigest":"33287362f579ab7f7024f428889c3678ea85c4bdcb98da63d5a61b0c70b46ff8"`,
the same digest on all four nodes. The loader, fed the same genesis: both forks
`[inactive at 29, active at 30]`. `tlsnProofEnforcement`: `activationHeight` is
`null` in the defaults, inactive at every height, so a TLSNotary identity claim
is accepted on its structure alone.

**2. Before the height (tip 3).** Domain-signed transfer, at `confirm`:
`Error: [Confirm] Transaction is not valid: [Tx Validation] [SIGNATURE ERROR]
Transaction signature verification failed`. The same transaction signed
legacy: `{"result":200,"response":{"message":"Transaction applied, waiting for
confirmation"},"require_reply":false,"extra":{"confirmationBlock":4,...,"disposition":"mempool"}}`,
block 4 on all four nodes.

**3. The activation block (tip 29).** `getNetworkInfo` signatureDomain:
`{"activationHeight":30,"activated":true,"currentHeight":29}`. Legacy copy:
the same signature error. Domain-signed copy: accepted, `"confirmationBlock":30`,
block 30 on all four nodes.

**4. After the height.** Legacy: the same signature error. Domain signature
bound to chain id 31338: the same signature error. SDK-signed (chain id 31337):
accepted, `"confirmationBlock":32`, block 32 on all four nodes. The SDK's
signature equals the one built from the node's `txSignaturePreimage`.

**5. Agreement.** Blocks 27 to 33: the same hash on all four nodes for every
block, each with 4 signatures; `getLastBlock` on each node is
`33:addf40c45446467f4437ae6440113b35dc09be7d95dfef5bc60da871f424fe41`. Balances
and nonces identical (read while the four tips agreed and held still); alice's
`999999999999999988000000000:3` on every node (three transfers, nothing
refused landed); bob holds exactly 3000000000.

**6. A validator without the schedule.** Node 4's genesis lost both fork entries
and the node restarted at tip 35.

- For each peer it logged `Peer http://node-1:53551 serves genesis data that
  differs from ours only in the fork schedule or chain id; keeping our
  data/genesis.json as it is`, then `FORK SCHEDULE MISMATCH with
  http://node-1:53551: schedule digest: ours 4cf16bec..., theirs 33287362...;
  signatureDomain: ours null, theirs 30; web2ProofBinding: ours null, theirs 30.
  This node will split from its peers at the first activation height that
  differs. ...`. Its file was left alone, and its `getNetworkInfo` says
  `{"activationHeight":null,"activated":false,"currentHeight":35}` with a digest
  different from the quorum's.
- The same domain-signed transfer: node 4 refused it with the signature error,
  node 1 accepted it (`"confirmationBlock":36`, block 36 on all four nodes).
- The same legacy-signed transfer from another account: node 1 refused it,
  node 4 accepted it. It landed in no block on any node.
- 9 candidate-block refusals by peers (`Hash does not correspond to our
  candidate block`) and `[STALL DETECTION] Drawn into the shard for block N but
  our signature is missing` for blocks 37, 38 and 39. Those blocks carry 3
  signatures and none is node 4's. After the third: `Missed 3 consecutive shard
  selections ... exiting for log investigation`, exit code 0.
- Block 36 was stored on node 4 anyway.

**7. Recovery.** The devnet compose restarted node 4 from the same file; it warned
again (`FORK SCHEDULE MISMATCH`) and was still on the wrong schedule. The
scenario then corrected its genesis file and restarted it: it loaded
`signatureDomain` at 30, logged no mismatch, reported the quorum's digest,
caught up, blocks 34 to 45 have the same hash on all four nodes, balances match,
blocks 44 and 45 carry 4 signatures with node 4's. The legacy-signed transfer
node 4 had admitted was gone from its mempool table. On testnet the node would
not have been restarted at all (see the failure-mode notes).

**8. Container health.** Nodes 1-3 not restarted by the engine; node 4 not
restarted by the engine after the operator's restart; no container killed for
memory. Peers occasionally make a node exit during the first minute (the devnet
start-up race; the script starts node 1 first), so the counts are compared from
the start of the scenario.

### What the runs left behind

Zero containers, volumes and networks of the `forkrehearsal` project after the
teardown. The image `forkrehearsal-node:<sha>` stays for the next run on the same
tree; remove it with `docker rmi`.
