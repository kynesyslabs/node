---
type: analysis
title: Validator concentration and the two-thirds attack
date: 2026-11-18
status: proposed
---

# Validator concentration and the two-thirds attack

Question: if one party holds many of the sold nodes, can it run a
"two-thirds plus one" attack, and how is that prevented at launch?

Short answer: the dangerous number is not a share of all validators, it
is a **count of seats in one committee**. A block is signed by a committee
of 10 drawn from the whole validator set, so a party that holds 4 seats of
one committee can stall the chain, and 7 seats can sign any block it
likes. A party that runs 13 of 40 validators (under a third) draws 7 or
more seats of a committee about once every 150 blocks. The launch rule
therefore caps every beneficial owner, operator and provider at **3
validators**, the seats a committee of 10 can lose, whatever the size of
the set. `scripts/launch-go-no-go.ts` enforces it (see
[Enforced in tooling](#enforced-in-tooling)).

Everything below is read from the `stabilisation` branch with the mainnet
genesis (every fork in `MAINNET_FORKS` at block 0, `networkGovernance` off).
Since node#1187 the set includes `tokenStaking` and `nftValidatorGating`, so
seats are NFT-gated from block 0; the bullets below that describe a frozen
launch set and DEM stakes predate that decision. Paths are relative to the repository root. Statements
marked *reading* come from code reading and were not run.

## How the code counts

### Committee and quorum

- `shardSize` is a genesis property, 10 on mainnet, read from block 0 and
  never changed after (`src/libs/consensus/genesisShardSize.ts`;
  `docs/mainnet/genesis.md`). Governance cannot change it
  (`src/features/networkUpgrade/constants.ts:55-57`).
- Quorum is one formula, `floor(shardSize * 2 / 3) + 1`
  (`src/libs/consensus/v2/quorum.ts:10-12`): **7 of 10**. The producer
  needs it of a full committee and of the members it polled (`quorum.ts:19-27`);
  sync needs the same bar under `quorumParity` (`quorum.ts:35-42`).
- One validator is one vote. Sync collects the set of distinct eligible
  identities whose signature verifies
  (`src/libs/blockchain/validation/verifyBlock.ts:107-133`) and compares its
  size with the threshold (`verifyBlock.ts:184-199`). Stake weighs nothing
  here.
- The committee for block h+1 is drawn per block from the pool:
  `drawBoundCommittee` takes the first `shardSize` of an unweighted
  seeded permutation of the pool (`src/libs/consensus/v2/routines/getShard.ts:267`,
  `:348`). The pool is the peerlist committed in the parent block
  intersected with the staked set; below the quorum it falls back to the
  whole staked set (`getShard.ts:302-326`). With `unpinnedCommittee` at 0 no
  identity is pinned.
- The seed hashes the last three block hashes and the genesis hash
  (`src/libs/consensus/v2/routines/getCommonValidatorSeed.ts:152-167`). A
  block hash covers the block timestamp, so the secretary that proposes
  block h chooses among the timestamps its co-signers accept (whole seconds,
  at most 5 s ahead of their clock,
  `src/libs/consensus/v2/routines/cosignTimestamp.ts:22`, `:53`) and so
  among several committees for h+1. `seedGrinding.test.ts` in the same
  directory pins how many.

### Failed rounds and halts

- A round that misses quorum throws `BlockInvalidError`
  (`src/libs/consensus/v2/PoRBFT.ts:684`) and the node retries the same
  height. There is no view change: every retry at a height draws **the same
  committee** (`getShard.ts:508`), and an offline member keeps its seat and
  counts as a missing vote. So 4 withheld votes in one committee stall that
  height until they come back (`boundCommittee.collusion.test.ts`, header).
- Fork schedule mismatch: under the `abstain` policy a node stops forging
  and voting when at least half of the staked set reports a different
  schedule and the difference is urgent (inside the fork window, another
  treasury, or another height for an active fork)
  (`src/libs/peer/routines/forkScheduleWatch.ts:244-258`). "At least half"
  (`differing * 2 >= total`) is the even-split fix, commit `fcf82df52`,
  first released in v1.0.0-rc.10. A 2-2 split halts instead of splitting the
  chain.

### Finality and conflicting blocks

- There is no reorg path. A peer that serves a certified block other than
  our tip is a `conflict` (`src/libs/blockchain/routines/Sync.ts:484`) and
  the node refuses to sync against it (`Sync.ts:1957-1960`). A block with a
  quorum of the bound committee is final in practice.
- Two certified blocks at one height share at least `2q - shardSize` = 4
  signers (`verifyBlock.ts:142`). So a conflicting pair needs at least 4
  committee members to sign both. Under `commitLock` a precommit
  equivocation is detected and logged
  (`src/libs/consensus/v2/commitLock/votes.ts:125-138`), and a node that sees
  its own key used elsewhere stops signing. **There is no slashing**: no
  code reduces a stake for misbehaviour.

### What sync re-checks

A syncing node accepts a block only after (`Sync.ts:1236-1256`):
recomputing the block hash, checking the quorum against the committee it
recomputes for that height, verifying every transaction signature
(`syncVerification.ts`), comparing the native table hashes with its own
state, and re-executing the transactions, rejecting the block if any
status differs. Under `editBinding`, `nativeSendBinding` and `feeBinding`
(all at 0) the GCR edits are regenerated from the signed transaction and
bound to the sender's own account; before `editBinding` a self-signed
transaction could carry a balance credit for anyone
(`src/forks/forkConfig.ts:150-155`), which is why it is a mainnet fork.

What sync cannot re-check is the committed **peerlist**: it is the
committee's merge of its members' observations. Honest members refuse a
peerlist they would not have merged
(`src/libs/consensus/v2/routines/peerlistMerge.ts:330-345`), but a block
with 7 valid signatures carries whatever peerlist those 7 signed.
*Reading:* 7 colluders in one committee can commit a peerlist of only
colluders, and while it holds at least 7 entries every later pool, and so
every later committee, is drawn from it alone (`getShard.ts:313-315`). One
captured committee becomes a captured chain.

### Stake and joining

- Stake is an eligibility threshold, not a weight, for consensus: the draw
  and the votes ignore it. It weighs only the governance tally (approve at
  `ceil(2/3)` of snapshot stake,
  `src/libs/blockchain/routines/tallyUpgradeVotes.ts:63`), and governance is
  refused at every layer while `networkGovernance` is off
  (`src/forks/governanceGate.ts:64-69`); the mainnet genesis leaves it off.
- The fork schedule comes only from the genesis file; no vote changes it.
- From block 1 anyone holding an allowlisted Node NFT can take a seat
  (`nftValidatorGating` and `tokenStaking` at 0, node#1187): one seat per
  NFT mint, stake forced to 0, a 20-block unstake lock, governance weight
  one per seat. An unstake or an eviction is refused when it would leave
  fewer than 7 active validators. The allowlist ties a seat to a mint, not
  to a person, so one holder of many NFTs still gets many seats: there is
  **no per-owner or total cap** beyond the number of allowlisted mints.

## Share controlled by one party, and what it can do

"Seats" are seats of one committee of 10 (quorum 7). With more than 10
validators, a party's seats vary per block with the draw; the right-hand
column says how often a share of the set turns into seats.

| One party controls | It can | It cannot | How often, with a set of 40 |
|---|---|---|---|
| ≤ 3 seats (under 1/3 of a committee) | Withhold its votes: rounds slow down (each dead member adds a timeout) but 7 honest still sign. As secretary, pick among a few timestamps to bias the next draw. Leave honest peers out of its own peerlist reports. | Stop a block, sign a block, censor | 3 validators can never hold 4 seats |
| ≥ 4 seats (≥ 1/3 of a committee, `n − q + 1`) | **Stall** the chain: withhold votes, and every retry draws the same committee, so the height stays stuck until it signs again. With a network partition of the honest members, sign two conflicting blocks (4 = `2q − n`); nodes then halt on the conflict rather than reorg | Sign a block alone, forge anyone's signature | 4 of 40: once every ~430 blocks; 7 of 40: 1 block in 20; 13 of 40 (under 1/3 of the set): 41 % of blocks |
| ≥ 1/2 of the staked set | Make honest nodes abstain by reporting another fork schedule or treasury inside an urgent window, which halts the chain (liveness only) | Change the schedule others run | — |
| ≥ 7 seats (≥ 2/3 + 1 of a committee) | **Sign any block alone**: choose and order transactions, censor any transaction (no forced inclusion), pick timestamps within the bounds, and commit a peerlist of only its own validators, keeping every later committee (*reading*). Stall at will. Submit L2PS settlement batches (a batch must be signed by a staked validator, `src/libs/l2ps/settlement/admission.ts:35`) | See the next section | 7 of 40: 1 in 155,000 blocks; 13 of 40: 1 in ~150 blocks; 20 of 40: 1 in 7 blocks |
| A whole committee | Same as ≥ 7 seats | Same | — |
| ≥ 2/3 of stake (once `networkGovernance` is on) | Pass a parameter proposal alone: minimum stake, fees, fee split, feature flags. More than 1/3 of stake vetoes any proposal (approval needs `ceil(2W/3)`, so exactly 1/3 cannot block) | Change `shardSize` or the fork schedule | Off at launch |

The frequencies are the hypergeometric chance that a uniform draw of 10
from 40 gives the party that many seats. Secretary timestamp choice and
peerlist capture only push them up. With blocks every few seconds, "1 block
in 150" is minutes: a share of the set **below a third is not safe**. Only
an absolute count of at most `shardSize − q` = 3 validators per party keeps
every possible committee under 4 seats.

## What 7 seats still cannot do

Every node re-executes the block, so a captured committee cannot:

- forge another account's signature, or spend, move or burn another
  account's balance (signatures re-verified on sync; edits regenerated and
  sender-bound under `editBinding`, `nativeSendBinding`, `feeBinding`);
- mint DEM: a credit with no matching signed debit fails the native table
  hash comparison and the status re-check, and the block is rejected;
- forge an L2PS settlement: every node verifies each transfer's Ed25519
  signature, the nonces and the PLONK proof at apply
  (`src/libs/l2ps/settlement/validation.ts:214-226`, `:311-331`); it can only
  delay or censor batches;
- forge a TLSNotary attestation: TLSN edits are derived by the node from
  the signed body and the block, never taken from the client
  (`src/libs/blockchain/gcr/tlsnTransitions.ts:23-33`), and a presentation
  is verified against the notary keys in the genesis, which the notary
  hosts hold, not the validators;
- award points: `awardPoints` must be signed by the genesis `sudoPubkey`
  (`src/libs/blockchain/validation/editBinding.ts:340-345`);
- change the fork schedule or `shardSize`, or turn governance on.

What it can abuse in Demos-specific state:

- **Identity:** proofs for TLSN, ZK, removals and Telegram are re-checked at
  apply; for the other web2 kinds the proof is checked only at admission,
  "admission policy, not a consensus rule"
  (`src/libs/blockchain/validation/identityAdmission.ts:45-66`). Its own
  committee can include identity claims for **its own accounts** with proofs
  an honest node would refuse at admission. Other accounts stay untouched
  (edits are sender-bound).
- **Ordering and censorship** of anything: transfers, L2PS batches, TLSN
  stores (a TLSN presentation must be stored within an hour of attesting, so
  a long censorship voids it), identity and storage transactions.
- **Liveness:** stall the chain indefinitely, or split it by equivocation
  under a partition, which halts nodes on the conflict and needs the manual
  recovery in `docs/runbooks/chain-halt-recovery.md`.

## Mitigations, ranked

### Launch-blocking (before genesis)

1. **Cap every beneficial owner at 3 launch validators** (the same cap as
   operators and providers), and require the owner column on mainnet. One
   buyer behind several operators and providers is one party. Enforced:
   `--plan` check "beneficial owner cap" and the T-0 go/no-go.
2. **Know the owners (KYC of node buyers)** and make the owner column true:
   the tooling counts names, it cannot see two names that are one person.
   The sale terms should state the cap and that hidden common ownership is a
   breach, with the right to exclude the node from the launch set. This is
   the part of the cap only the business side can enforce.
3. **Widen the set**: more independent owners make each sampled committee
   more diverse, and the cap of 3 means a buyer of more nodes runs at most 3
   at launch. The rest wait for post-launch admission under the same rule.
4. **Region share under a third** and **stake share under a third** per
   owner, operator, provider and region: enforced as the checks "region
   share" and "stake share". Stake share matters only once governance is on,
   but genesis stakes cannot be changed later without the staking fork.
5. **Equivocation and committee-share monitoring from block 1**: alert on
   precommit equivocation (the existing double-sign alert), on any block
   whose signers share one owner for 4 or more seats (needs the owner table
   at the monitoring host), and on a committed peerlist that drops
   validators that are online.

### Post-launch

6. **An allowlist for joining**, curated per owner: the node#1187 NFT
   allowlist gates joining by mint, not by owner, so the owner side still
   needs an approval step in #11's growth plan. Without a cap, open staking lets any
   party add validators until it holds 13 of 40, which is under a third and
   still captures a committee every few minutes.
7. **On-chain per-owner limits are not possible** without identity: one
   party can use many keys. The allowlist (6) plus KYC (2) is the control;
   the on-chain rule can only cap seats per allowlisted entity.
8. **Re-run the owner cap at every set change**: any new validator goes
   into the same table, and `launch-go-no-go.ts --plan` is re-run on the new
   set before the change.
9. **Fix the peerlist capture** (*reading*): bound how far a committed
   peerlist may shrink the pool against the staked set per block, so one
   captured committee cannot keep the chain. Needs a fork.
10. **Slashing or ejection for equivocation**: today a proven double-sign
    is only logged. Needs a fork and a governance path.
11. **Bigger committees** reduce the sampling risk (seats track the set
    share more closely as `shardSize` grows) but cost latency, and
    `shardSize` is fixed at genesis, so it is a new chain.

## Enforced in tooling

`scripts/launch-go-no-go.ts` reads the launch validator table
(`--operators`, [launch-validators.md](launch-validators.md)), now with an
`owner` column:

| Check (`--plan` line) | Rule | Code |
|---|---|---|
| operator and provider cap | no operator or provider runs more than `min(launch, 10) − 7` | `scripts/launch-go-no-go.ts:353`, `:392` |
| voting power per operator and provider | none holds more than a third of the first committee | `:402` |
| beneficial owner cap | on the mainnet chain id every entry names an owner; no owner over the same cap or third | `:379`, `:448` |
| region share | no region hosts a third or more of the launch validators | `:415` |
| stake share | no owner, operator, provider or region holds a third or more of block 0's `staked_amount` | `:462` |

The T-0 go/no-go (`checkLaunch`) applies the same rules, so a table that
was edited after `--plan` is caught on launch day. On the testnet and
devnet chain ids the owner column is optional, so rehearsal tables keep
working.
