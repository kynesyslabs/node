---
type: reference
title: Mainnet must-match parameters
date: 2026-11-05
status: active
---

# Mainnet must-match parameters

Some settings that decide whether a block or a transaction is valid are read
from each node's own environment, not from the genesis. Every mainnet
validator must run the same values, or nodes start disagreeing about blocks
and transactions the others accept.

The values are in [`parameters.env`](parameters.env), the file operators copy
into `.env` and `./scripts/node-doctor --production` checks against. This page
says, for each one, where the node reads it and what breaks when one validator
differs. The two files must not disagree; a test
(`src/config/mainnetParameters.test.ts`) fails when the sheet, the node's
built-in values or `docker-compose.yml` drift apart.

## How the values reach the node

1. Copy every `KEY=value` line of `parameters.env` into `.env` (INSTALL.md,
   "Run a released image", step 3). Set them explicitly even where they equal
   the node's built-in value, so a later change of a default can never move a
   validator off the sheet without anyone noticing.
2. Docker passes only the variables that `docker-compose.yml` lists under the
   node service's `environment:`; `.env` itself never enters the image. Every
   key in the sheet is listed there.
3. Check what the container will get, and what it got:

   ```bash
   ./scripts/node-doctor --production          # compares with parameters.env
   docker compose config --format json | python3 -c 'import json,sys; e=json.load(sys.stdin)["services"]["node"]["environment"]; [print(k+"="+str(e.get(k))) for k in sys.argv[1:]]' $(grep -oE "^[A-Z_0-9]+" docs/mainnet/parameters.env)
   docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(docker compose ps -q node)" | grep -E "^($(grep -oE '^[A-Z_0-9]+' docs/mainnet/parameters.env | paste -sd'|'))="
   ```

   The first command fails on any difference. The second prints the values
   compose resolves before the start; the third prints the values inside the
   running container. Each key must show the sheet's value.

A bare-metal node reads the process environment and then `.env`; run
`./scripts/node-doctor --production --env-from env` there.

## The values

| Variable | Mainnet | Read in | What breaks when one validator differs |
|---|---|---|---|
| `CONSENSUS_TIME` | `10` | `SharedState.getConsensusTime()`; empty or `0` falls back to `DEFAULT_BLOCK_TIME` (10) | It is the block interval: the forge floor (`createBlock`), the secretary's "too early" abort (`secretaryManager`), the round trigger (`consensusTime.ts`), stall detection and the peer liveness window (`PeerManager.livenessWindowMs`). A node with a shorter time tries to forge rounds its peers abort; a longer one clamps block timestamps the others did not propose. Set explicitly, it also makes the published `blockTimeMs` network parameter report 10000 instead of the 1000 placeholder. |
| `BLOCK_TIMESTAMP_MIN_DELTA` | `1` | `verifyBlock` (`checkTimestampAgainstParent`) | The least number of seconds a block's timestamp must exceed its parent's. A node with a larger value rejects blocks the others accept and stops following the chain. |
| `BLOCK_TIMESTAMP_TOLERANCE` | `60` | `verifyBlock` | How far a block's timestamp may lead the verifier's clock. A node with a smaller value rejects blocks the others accept. |
| `NETWORK_FEE` | `1` | `loadNetworkParameters` (genesis value under governance), `calculateCurrentGas` | Fee component in DEM, the genesis value that governance upgrades replace. Ingress (`applyGasFeeSeparation`) refuses a transaction whose shipped fee differs from the node's own computation, and under `feeBinding` pool admission and block apply refuse it too. Apply refuses by failing the transaction, not the block, and the block hash commits to transaction hashes only, so a validator with another value diverges in one of two ways. Forging the block with the others, it commits that transaction as failed while they confirm it: its balances and nonces differ from theirs, and under `finalityProofs` its results root for that block differs, so the next block's `parent_results_root` no longer matches. Syncing the block, it finds the served status disagreeing with its own and rejects the block, so it stops following the chain. |
| `RPC_FEE` | `1` | same as `NETWORK_FEE` | same as `NETWORK_FEE`. |
| `BURN_FEE` | `1` | `SharedState.burnFee`, read only by dormant `calculateCurrentGas` paths | Governance never refreshes it, so the env value is the only source. The dormant balance-for-gas check in `validateTransaction` has no caller; this value does not affect live native sends. |
| `RPC_FEE_PERCENT` | `10` | `SharedState.rpcFee` initial value only | Overwritten by `RPC_FEE` at boot, so nothing depends on it today. Kept on the sheet so no node carries a stray value if code starts reading it again. |
| `MIN_VALIDATOR_STAKE` | `1000000000000` (1000 DEM in OS) | `getGenesisNetworkParameters`, `getMinValidatorStake` (stake tx validation), `getBigintBounds` (governance floor = 1%) | A node with another floor accepts or refuses stake transactions the others do not, and checks governance proposals against another floor. |
| `ZK_ATTESTATION_POINTS` | `10` | `zkRoutines` (ZK attestation apply) | Points are written into the sender's account at apply. A node with another value holds different points for the same chain, and since the block's `native_tables_hashes` do not cover accounts, nothing flags it. |
| `PROD` | `true` | `SharedState.PROD`, `loader.ts` | Production refusals (loopback or missing `EXPOSED_URL`, missing build commit, missing identity file) and the block-signing policy. Overdraft refusal no longer depends on it. A node whose genesis has the mainnet chain id refuses to start without it (`devModeProblem`). |
| `DEMOS_REQUIRE_VALIDATORS` | `true` | `getShard`, `loader.ts`, `findGenesisBlock` | Without it a node that cannot read the validator set uses every online peer as the committee, and `warn` mismatch policy is not refused. A node whose genesis has the mainnet chain id refuses to start without it (`requireValidatorsProblem`). |
| `FORK_SCHEDULE_MISMATCH_POLICY` | `abstain` | `loader.ts` | `warn` keeps voting on another fork schedule inside the pre-activation window; a validator would sign blocks its peers reject at the activation height. The node refuses `warn` together with `DEMOS_REQUIRE_VALIDATORS=true`. |
| `EXPECTED_GENESIS_HASH` | published with the genesis | `findGenesisBlock`, `genesisMismatch` | Without it a fresh node can adopt whatever genesis its first peers serve. The value is added to `parameters.env` when the genesis is published ([genesis-hash.md](genesis-hash.md)); until then `node-doctor` checks only that it is a 64-hex hash. |
| `EXPECTED_GENESIS_BLOCK_HASH` | published with the genesis | `findGenesisBlock` | Two genesis files with one genesis hash can still build different blocks 0; this pin refuses any other block 0. Same publication as above. |

### Launch settings

These keys do not decide whether a block is valid, so a node with another
value stays on the chain. They are on the sheet so that every validator
starts with the same public surface, and `node-doctor --production` checks
them like the values above.

| Variable | Mainnet | Why |
|---|---|---|
| `SIGNALING_ENABLED` | `false` | The WebRTC signaling server (`RPC_SIGNALING_PORT`, 3005) serves instant-messaging clients; consensus does not use it. While it runs, each online message becomes a node-signed `instantMessaging` transaction with no fee, and the online path has no per-sender cap. When it is off, the node logs `Signaling server disabled (SIGNALING_ENABLED=false)` and `/health` lists the `signaling` subsystem as skipped. Compose still publishes the port; nothing answers on it. |
| `XM_ENABLED`, `DEMOSWORK_ENABLED` | `true` | Decided 2026-11-28: cross-chain (XM) execution and DemosWork run at launch, as in the code default (`src/config/defaults.ts`). The sheet states it so `node-doctor` flags a validator that turned them off. The hardening items for XM and Web2 transactions are tracked on mainnet-launch#38. |

The `v1.0.0-rc.11` tag carries a sheet without these lines. A validator
installing that tag appends `SIGNALING_ENABLED=false` to `.env` by hand,
after the sheet, and confirms the container has it:

```bash
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(docker compose ps -q node)" | grep '^SIGNALING_ENABLED='
```

L2PS and TLSNotary are not switched here: `l2psSettlement` and `tlsnVerified`
are at block 0 and their kill switches, `l2psGate` and `tlsnDisabled`, are
unscheduled in the mainnet genesis, so L2PS settles on every node and every
node verifies TLSNotary presentations against the notary keys in the genesis,
whatever its environment says ([genesis.md](genesis.md)). The `tlsnVerified`
payload (notary keys, verifier wasm sha256, `maxPresentationBytes`,
`freshnessWindowSec`, `futureSkewSec`) is a genesis value, not an environment
setting: a node cannot override it.

### Must stay disabled

`node-doctor --production` fails if any of these has a value other than blank,
`false` or `0`:
`DEBUG_ASSERTIONS_ENABLED` (debug-only; the node refuses it when enabled at boot
with `PROD=true`), `DEMOS_DISABLE_FORK_MACHINERY` (the node also refuses it at boot on
any chain id other than the testnet's and the devnets'), `DEMOS_ALLOW_UNPINNED_GENESIS`
(refused at boot on the same chain ids),
and the one-start switches `DEMOS_GENERATE_IDENTITY`,
`DEMOS_IDENTITY_TAKEOVER`, `DEMOS_SIGNING_RECORD_REBIND` and
`DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST`.

### Not on the sheet

- Chain id, shard size, fork heights, the treasury address and the sudo key
  come from the genesis file, so they match by construction.
- The reference block room (how far behind the head a transaction's
  reference block may be: 1, or 10 from the `referenceBlockRoom10` fork,
  with a deep window of five times that) is a code constant chosen by the
  genesis fork schedule, so it matches by construction too.
- Ports, database settings, L2PS limits, rate limits and the watchdog are
  per-node: they change how one node runs, not which blocks it accepts.
- `MAX_MESSAGE_SIZE` is parsed but never read.

## Values that are product choices

The sheet uses the current built-in values. These are product decisions
rather than technical constraints:

- Fees of 1 DEM per component (the code still carries a note that the three
  should later add up to 1 DEM). A native send pays `NETWORK_FEE` +
  `RPC_FEE` = 2 DEM; `BURN_FEE` is not charged on top, the burn share comes
  out of the network fee (INSTALL.md, "Fees charged per native send").
- The 1000 DEM validator stake floor.
- 10 points per ZK attestation.
- The 10 s block time and the 1 s / 60 s timestamp bounds (the time policy
  itself is tracked separately).
