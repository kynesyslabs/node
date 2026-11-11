/**
 * Fork configuration registry.
 *
 * P2 of the DEM → OS denomination migration introduced *hard-fork machinery*
 * without activating any rule changes. DEM-665 (gas fee separation) adds a
 * second fork name and extends the config shape to a discriminated union:
 * each fork may carry its own payload alongside the common
 * `activationHeight` / `description` fields.
 *
 * Activation heights and per-fork payloads are loaded from `data/genesis.json`
 * via the loader in `loadForkConfig.ts` and hydrated into
 * `SharedState.forkConfig` at startup (see `src/utilities/sharedState.ts`).
 *
 * Distribution percentages for gas-fee separation do NOT live here — they
 * are governance-mutable via NetworkParameters. Only the fork-level
 * immutable bits (treasuryAddress) ride in the fork payload. Burn address
 * is a code constant in `migrations/gasFeeSeparation.ts`, never genesis-
 * driven.
 */

// REVIEW: DEM-665 — fork config registry extended for gasFeeSeparation.

/**
 * Common fields every fork config carries. Per-fork variants extend this
 * with their own payload (see `OsDenominationConfig`,
 * `GasFeeSeparationConfig`).
 *
 * @property activationHeight Block height at which the fork rules become
 *   active. `null` means the fork is configured but not scheduled and will
 *   never activate.
 * @property description Optional human-readable rationale, surfaced for
 *   operators / diagnostics. Not consumed by consensus.
 */
export interface BaseForkConfig {
    activationHeight: number | null
    description?: string
}

/**
 * `osDenomination` fork: DEM → OS migration. No payload beyond the base.
 *
 * Declared as a `type` alias rather than an empty `interface … extends`
 * to avoid the eslint `@typescript-eslint/no-empty-object-type` rule
 * (CodeRabbit PR #817 feedback). Structurally identical to
 * `BaseForkConfig`; consumers narrow via `ForkName`, not via runtime
 * shape.
 */
export type OsDenominationConfig = BaseForkConfig

/**
 * `nonceEnforcement` fork (audit-sweep batch C): activates per-sender nonce
 * checks at admission and the native forged-edit guard at apply.
 *
 * Pre-fork: admission accepts any nonce, apply runs the shipped edits as
 * written. Bit-identical to legacy for re-sync.
 *
 * Post-fork: admission refuses a nonce at or below the sender's confirmed
 * nonce, apply refuses a native tx whose edits differ from the regenerated
 * set, and a tx hash already in a confirmed block is not applied again.
 * Apply does not compare the nonce itself: that rule, and a failed tx
 * spending its nonce, come with `nonceIntegrity`.
 *
 * No payload beyond the base. Declared as a type alias (not an empty
 * interface) for the same reason as `OsDenominationConfig`.
 */
export type NonceEnforcementConfig = BaseForkConfig

/**
 * `signatureDomain` fork: transaction signatures stop covering the bare
 * `tx.hash` and start covering `demos-tx:v1:<chainId>:<hash>` (see
 * `libs/crypto/txSignaturePreimage.ts`).
 *
 * Pre-fork: the signed bytes are `TextEncoder(tx.hash)` — byte-identical to
 * legacy, so re-sync and old clients keep validating.
 *
 * Post-fork: a signature no longer doubles as a signature over an arbitrary
 * 64-hex message (a wallet asked to sign a "login nonce" can no longer be
 * tricked into signing a transaction), and it is bound to one network, so a
 * transaction cannot be replayed onto another chain that shares the account.
 *
 * Activating it requires signers and verifiers to move together: the node,
 * the SDK and the wallet all derive the preimage from the same helper.
 */
export type SignatureDomainConfig = BaseForkConfig

/**
 * `web2ProofBinding` fork: a web2 identity proof must sign
 * `demos-web2:v1:<context>:<username>:<sender>` instead of the constant
 * `"dw2p"`, so a published proof cannot be reused to claim a handle its
 * signer does not own (see `libs/abstraction/web2/boundMessage.ts`).
 *
 * Pre-fork: both shapes verify, so clients can migrate without a flag day.
 * Post-fork: only the bound shape, and a proof lifted from someone else's
 * post stops verifying.
 *
 * The same height also switches block application to compare web2 account
 * ids in canonical form (the number 42 and the string "42" as one account)
 * in its duplicate, first-connection and points checks; that part is judged
 * at the tip like the other apply-time gates.
 */
export type Web2ProofBindingConfig = BaseForkConfig

/**
 * `xmProofBinding` fork: a cross-chain (xm) identity proof must sign
 * `demos-xm:v1:<chain>:<targetAddress>:<sender>:<issuedAt>`, issued within the
 * last ten minutes, instead of any text the client picks (see
 * `libs/identity/xmProof.ts`).
 *
 * Pre-fork: any signed text verifies, so wallets and SDKs can migrate without
 * a flag day. Post-fork: an old signature by the wallet (a login message,
 * another dapp's challenge) stops being a valid proof, and a proof names the
 * Demos account it was made for. Like `web2ProofBinding` it is an admission
 * policy, judged for the block the proof would land in.
 */
export type XmProofBindingConfig = BaseForkConfig

/**
 * `tlsnProofEnforcement` fork: refuse TLSNotary identity claims the node
 * cannot actually verify.
 *
 * `verifyTLSNotaryPresentation` checks that the presentation is an object
 * holding a long-enough hex string and returns
 * `verifyingKey: "structure-validation-only"` — the cryptography is done in
 * the client, which decides nothing for consensus. Everything else in the
 * claim (`revealedRecv`, `recvHash`, `username`, `userId`) is supplied by the
 * same caller and only checked against itself, so any account can attach any
 * GitHub, Discord or Telegram identity by authoring its own bytes.
 *
 * Active, a `tlsn_identity_assign` is rejected until the node verifies the
 * notary signature itself. Inactive, the legacy structure-only behaviour
 * stays, for test networks that depend on it.
 */
export type TlsnProofEnforcementConfig = BaseForkConfig

/**
 * `atomicWork` fork: lets a transaction carry Work edits (resource-slot
 * CAS, Work attempt, storage put) that apply all-or-nothing, with a
 * receipt the node builds.
 *
 * Dormant by default (`activationHeight: null`): until a height is pinned,
 * every Work edit is refused at apply, so a node carrying the code applies
 * exactly what a node without it does. No payload beyond the base.
 */
export type AtomicWorkConfig = BaseForkConfig

/**
 * `editBinding` fork: a transaction is admitted to a pool and applied by a
 * block only when the edits it ships are exactly the ones the node
 * regenerates from the signed body, for every transaction type, and each edit
 * that names an account acts on the sender's own.
 *
 * Before it, the edits of a non-native transaction were applied as written:
 * a self-signed transaction could carry a balance credit, a vote recorded
 * under another validator or a nonce bump on someone else's account, and
 * every node that applied or synced the block applied them too.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`): until a height is
 * pinned, admission and apply behave exactly as they did, so a node carrying
 * the code agrees with a node without it. A chain started from genesis with
 * this build sets it to 0. No payload beyond the base.
 */
export type EditBindingConfig = BaseForkConfig

/**
 * `nonceIntegrity` fork: one confirmed or failed transaction per sender
 * nonce, enforced where every node reads the same state.
 *
 * - A transaction must ship exactly one nonce edit: +1 on the sender's own
 *   account, not a rollback. Edit-free node transactions ship none. Checked
 *   at gossip, at the consensus merge and before a block applies it.
 * - Apply refuses a transaction whose nonce is not the sender's nonce + 1 on
 *   the state the earlier transactions of the block left.
 * - A transaction that passes that check and then fails in the block still
 *   spends its nonce, so it cannot be signed again for another transaction.
 * - Admission refuses a nonce more than `MEMPOOL_MAX_NONCE_AHEAD` past the
 *   confirmed one and a second pending transaction for the same nonce.
 *
 * Before it, a failed transaction restored its sender's nonce while a later
 * one of the same block still applied, leaving the account one behind the
 * chain and the failed nonce free to be signed again.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`), so a node carrying
 * the code applies existing history exactly as before; a chain started from
 * genesis with this build sets it to 0. No payload beyond the base.
 */
export type NonceIntegrityConfig = BaseForkConfig

/**
 * `quorumParity` fork: a synced block is accepted only with the signatures
 * a producer needs to commit it, 2/3 + 1 of a full committee
 * (`shardSize`), however small the eligible pool at its height is.
 *
 * Before it, sync counted the quorum against min(shardSize, pool): a block
 * whose parent committed a peerlist of two validators was accepted with two
 * signatures, though no honest producer commits below the committee floor.
 *
 * Activation at H applies to block H and later. Dormant by default
 * (`activationHeight: null`), so a node carrying the code syncs existing
 * history exactly as before; a chain started from genesis with this build
 * sets it to 0. No payload beyond the base.
 */
export type QuorumParityConfig = BaseForkConfig

/**
 * `committeeBinding` fork: the committee for block h is a pure function of
 * the chain up to h - 1 (eligible pool, common validator seed, pins), and a
 * block counts only signatures by members of that committee.
 *
 * Before it, the committee was the ranked pool filtered by the forger's own
 * view of who is online, and sync counted signatures from any pool member.
 * With a pool larger than the quorum allows to split, two partitions could
 * each draw a committee, reach 2/3 + 1 of shardSize and finalize different
 * blocks at one height, both accepted by sync.
 *
 * Activation at H applies to block H and later. Dormant by default
 * (`activationHeight: null`), so a node carrying the code agrees with one
 * without it; a chain started from genesis with this build sets it to 0.
 * No payload beyond the base.
 */
export type CommitteeBindingConfig = BaseForkConfig

/**
 * `commitLock` fork: a committee member signs a block twice, a prevote and
 * a precommit, each bound to the height and round, and locks on a block
 * once it holds a proof of lock (2/3 + 1 committee prevotes in one round).
 * A block carries 2/3 + 1 committee precommits of one round.
 *
 * Before it, a member's single signature was both its vote and part of the
 * certificate, so a retried height could certify a second block with the
 * same signers while the first was committed by a member that was then cut
 * off.
 *
 * It relies on the bound committee for its quorum and its overlap argument,
 * so the loader refuses a genesis that schedules it at a height where
 * `committeeBinding` is not active. Activation at H applies to block H and
 * later. Dormant by default (`activationHeight: null`); a chain started from
 * genesis with this build sets it to 0. No payload beyond the base.
 */
export type CommitLockConfig = BaseForkConfig

/**
 * `finalityProofs` fork: block N commits its own height, the Merkle root of
 * block N - 1's transaction results and the hash of block N - 1's validator
 * set, so a client holding a signed block can prove a transaction's outcome
 * offline. The commitments lag one block because a block is voted on before
 * its transactions execute.
 *
 * Activation at H applies to block H and later. Dormant by default
 * (`activationHeight: null`): it adds fields to the hashed block content, and
 * a missing genesis entry hydrates from here. A chain launched from genesis
 * with this build sets 0. No payload beyond the base.
 */
export type FinalityProofsConfig = BaseForkConfig

/**
 * `unpinnedCommittee` fork: no identity is guaranteed a committee seat. The
 * three validator keys in `PINNED_SHARD_IDENTITIES` stop being moved to the
 * front of the committee (and so to the secretary seat) whenever they are
 * eligible; every member is drawn by the seed alone.
 *
 * Activation at H applies to the committee of block H and later. Dormant by
 * default (`activationHeight: null`): the testnet's committees, and so its
 * signatures, depend on the pins. A chain launched from genesis with this
 * build sets 0. No payload beyond the base.
 */
export type UnpinnedCommitteeConfig = BaseForkConfig

/**
 * `identityCarryover` fork: a chain whose genesis carries user data over
 * from another network (identities, points, referrals) without its money.
 *
 * At genesis (active at height 0) the snapshot import refuses any account
 * with a non-zero balance and a manifest whose `balance_sum` is not 0, and
 * a genesis validator list must equal the snapshot's `validators.jsonl`.
 * The import also records every identity it carried over.
 *
 * At apply, from the activation height:
 *  - a first-link award is never paid for an identity the genesis import
 *    carried: its points came over with the account it was linked to;
 *  - a web2 unlink names one platform account by `userId`; a request that
 *    names only a username is resolved to the single link carrying it.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`), so a node carrying
 * the code applies existing history exactly as before. A mainnet genesis
 * sets 0. No payload beyond the base.
 */
export type IdentityCarryoverConfig = BaseForkConfig

/**
 * `stakeApplyChecks` fork: the staking rules hold where the stake is
 * applied, not only at the node that took the transaction in.
 *
 * At apply, from the activation height:
 *  - a stake is taken from the sender's balance (refused when the balance
 *    does not cover it) and recorded as bonded; exit pays the bonded amount
 *    back, once, so a stake that was never debited is never paid out;
 *  - entering the validator set, as a new validator or one that exited,
 *    takes at least the minimum stake and a connection URL;
 *  - an unstake must come from an active validator with no unstake under
 *    way, and is refused when it would leave fewer active validators than
 *    the committee floor, below which no block is forged.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`), so a node carrying
 * the code applies existing history exactly as before. A mainnet genesis
 * sets 0. No payload beyond the base.
 */
export type StakeApplyChecksConfig = BaseForkConfig

/**
 * `tokenStakingGate` fork: the validator set is the genesis list until
 * `tokenStaking` opens token staking. A `validatorStake` or
 * `validatorUnstake` transaction, and a `validatorStake` edit that stakes,
 * unstakes or is an exit flagged `isRollback` in a transaction of any type,
 * is refused at RPC intake, at pool admission and at apply.
 *
 * It refuses what a chain without it accepts, so it is the fork that is
 * scheduled, not the one that opens staking: a genesis that leaves it out
 * keeps staking open, and a build that does not know it refuses to boot on
 * a genesis that schedules it instead of applying stakes its peers refuse.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`), so a node carrying
 * the code applies existing history exactly as before. A mainnet genesis
 * sets 0. No payload beyond the base.
 */
export type TokenStakingGateConfig = BaseForkConfig

/**
 * `tokenStaking` fork: token staking opens by network upgrade. From its
 * activation height a stake or unstake is judged by the staking rules again,
 * as on a chain without `tokenStakingGate`; without that gate it changes
 * nothing.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`) and at launch: a
 * mainnet genesis leaves it null, and a later height-pinned activation turns
 * token staking on. No payload beyond the base.
 */
export type TokenStakingConfig = BaseForkConfig

/**
 * `nativeSendBinding` fork: a native send pays the recipient and the amount
 * its signed body names. The payment is applied from the native payload's
 * args, while explorers, receipts and the RPC balance check read
 * `content.to` and `content.amount`; nothing compared them, so a sender
 * could sign a receipt for one payee and pay another.
 *
 * At admission (gossip ingest, consensus merge) and at apply, from the
 * activation height, a native send is refused unless `args[0]` is
 * `content.to` and `args[1]` pays what `content.amount` names. Amounts are
 * compared in ledger units: args are paid as written, while a body number is
 * DEM after osDenomination, as the signature hash reads it.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default; a mainnet genesis sets 0. No payload beyond
 * the base.
 */
export type NativeSendBindingConfig = BaseForkConfig

/**
 * `canonicalAddresses` fork: account keys are lowercase hex. The ledger keys
 * an account by the exact string, so `0xAB…` and `0xab…` are two accounts,
 * and a transfer to an upper-case spelling lands in one no wallet reads.
 *
 * At admission and at apply, from the activation height, a transaction is
 * refused when its sender, the recipient of a native send, or the account of
 * any balance edit it carries is a hex address with an upper-case digit.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default; a mainnet genesis sets 0. No payload beyond
 * the base.
 */
export type CanonicalAddressesConfig = BaseForkConfig

/**
 * `feeBinding` fork: the fee a native transaction carries is the one the
 * network charges. Apply derives the fee edits from the shipped
 * `transaction_fee`, which only the RPC confirm step compared with the
 * network's fee, so a transaction gossiped or merged straight into a pool
 * could pay less, or route the rpc share to an account of its choosing.
 *
 * At admission and at apply, from the activation height, and while
 * `gasFeeSeparation` is active, a native transaction is refused unless each
 * shipped fee component charges what the network computes and it names no
 * `rpc_address`. Compared on what apply deducts: apply charges a component
 * in ledger units as written, so after osDenomination a DEM number would pay
 * a billionth of the fee its hash commits to.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default; a mainnet genesis sets 0. No payload beyond
 * the base.
 */
export type FeeBindingConfig = BaseForkConfig

/**
 * `telegramSenderBinding` fork: a Telegram identity attestation must have
 * been made for the account that submits it. The user's challenge
 * signature inside the attestation (`payload.public_key`) has to be the
 * transaction sender's key.
 *
 * Before it, any account could submit an attestation the bot issued to
 * someone else (they are public once linked) and link that Telegram
 * account to itself. Judged when the proof is verified, both at
 * admission and at apply, at the tip, so a block applied on tip H or later
 * refuses a foreign attestation. Dormant by default; a mainnet genesis sets
 * 0. No payload beyond the base.
 */
export type TelegramSenderBindingConfig = BaseForkConfig

/**
 * `xmRemoveCanonical` fork: removing a cross-chain (xm) identity finds the
 * stored entry by the chain's canonical address form, the same comparison
 * admission uses for duplicates, instead of the client's `isEVM` flag and
 * the raw `targetAddress`.
 *
 * Before it, a remove compared the raw address unless the request said
 * isEVM, so it missed an entry stored lower-cased or under its
 * displayAddress, and a request claiming isEVM on a case-sensitive chain
 * lower-cased both sides and could take an entry that differs from the
 * named one only in case. An apply-time rule, judged at the tip.
 * Dormant by default; a mainnet genesis sets 0. No payload beyond the base.
 */
export type XmRemoveCanonicalConfig = BaseForkConfig

/**
 * `l2psSettlement` fork: an `l2psBatch` moves L1 balances on every node, in
 * the block that carries it, through a settlement record (net change per
 * account, the senders' signed transfer commitments and a PLONK proof that
 * ties them together). Spec: docs/design/l2ps-zk-settlement.md, "Interface v1".
 *
 * Before it, only the entry node applied a batch's edits, from its local
 * `l2ps_proofs` rows, so every other node's balances diverged (DEM-816).
 * Active, that local path is off, a batch without a valid settlement fails
 * with no edits, and members refuse old-format L2PS transfers. Dormant by
 * default; a mainnet genesis sets 0. No payload beyond the base.
 */
export type L2psSettlementConfig = BaseForkConfig

/**
 * `networkGovernance` fork: admits and applies the two network-upgrade
 * transactions, `networkUpgrade` and `networkUpgradeVote`.
 *
 * Inactive, both types are refused at RPC intake, at pool admission and at
 * apply, and so is a transaction of any type that carries a governance edit.
 * Active, a governance edit is applied only inside a transaction of its own
 * type and only for the account that signed it, so a vote counts for the
 * validator that cast it and a proposal for the validator that made it.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Block H deletes the proposals and votes recorded before H, which
 * only nodes that ran an older binary hold. Dormant by default
 * (`activationHeight: null`) and at launch: the
 * vote weights and quorum rules are not ready for a live network, so a
 * later height-pinned activation turns it on. No payload beyond the base.
 */
export type NetworkGovernanceConfig = BaseForkConfig

/**
 * `txTypeAllowList` fork: a transaction is admitted to a pool by the
 * consensus merge and applied by a block only when its type is one the node
 * implements (`BLOCK_TX_TYPES` in `libs/blockchain/validation/txTypes.ts`).
 *
 * Before it, the SDK gave a transaction of any type the universal gas and
 * nonce edits, so an escrow, contract, token or made-up type was applied as a
 * fee and a nonce with its own effect silently dropped.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`), so a node carrying
 * the code applies existing history exactly as before; a chain started from
 * genesis with this build sets it to 0. No payload beyond the base.
 */
export type TxTypeAllowListConfig = BaseForkConfig

/**
 * `instantMessagingBinding` fork: an `instantMessaging` transaction without
 * edits, the form the signalling server stores a message in, is merged and
 * applied only when every signer field names a validator staked at the tip.
 *
 * Before it, that form paid no fee and spent no nonce whoever signed it, so
 * any key could have such transactions merged into blocks and applied for
 * free. A message that carries the universal gas and nonce edits pays like
 * any transaction and is not affected.
 *
 * Activation at H binds from the block applied on tip H, which is block
 * H + 1. Dormant by default (`activationHeight: null`), so a node carrying
 * the code applies existing history exactly as before; a chain started from
 * genesis with this build sets it to 0. No payload beyond the base.
 */
export type InstantMessagingBindingConfig = BaseForkConfig

/**
 * `blockCaps` fork: bounds what one block takes from the pool and what one
 * sender holds in it.
 *
 *  - A block takes at most BLOCK_MAX_TXS txs and BLOCK_MAX_CONTENT_BYTES of
 *    canonical tx content, chosen deterministically from the merged pool
 *    (see selectBlockTransactions); the rest stay pooled for later blocks.
 *    A rebuilt locked candidate over either cap is not prevoted.
 *  - The consensus mempool merge holds each sender to the admission cap
 *    (MEMPOOL_MAX_PENDING_PER_SENDER), keeping the sender's lowest nonces,
 *    so every member that has seen the same txs keeps the same ones.
 *
 * Activation at H applies to block H and later; the merge reads the block
 * it prepares (tip + 1). Dormant by default (`activationHeight: null`): it
 * changes which txs a block contains, and a missing genesis entry hydrates
 * from here. A chain launched from genesis with this build sets 0. No
 * payload beyond the base.
 */
export type BlockCapsConfig = BaseForkConfig

/**
 * `gasFeeSeparation` fork (DEM-665): splits the single lump-sum gas fee
 * into three components (network / rpc / additional) with distinct
 * distribution rules, plus a new special-ops rule for TLSN.
 *
 * Payload:
 *  - `treasuryAddress`: ed25519 public key (lowercase hex, `0x` + 64 hex
 *    chars = 66 chars total) that receives the treasury portion of every
 *    fee distribution. Consensus-significant — must match across all
 *    validators. Phase 1 is immutable fork-payload; a future epic may
 *    migrate ownership to governance.
 *
 * Burn address is a code constant (`0x` + 64 zeros), NOT in genesis —
 * it never rotates. Distribution percentages live in NetworkParameters
 * (governable from day 1 with tight bounds + sum-100 invariant).
 */
export interface GasFeeSeparationConfig extends BaseForkConfig {
    treasuryAddress: string
}

/**
 * Discriminated union over all known fork configs. The discriminant is
 * the key in `Record<ForkName, ForkConfig>` (not a tag on the value),
 * so consumers narrow by reading via `forkConfig.gasFeeSeparation` etc.
 */
export type ForkConfig =
    | OsDenominationConfig
    | GasFeeSeparationConfig
    | NonceEnforcementConfig
    | SignatureDomainConfig
    | Web2ProofBindingConfig
    | XmProofBindingConfig
    | TlsnProofEnforcementConfig
    | AtomicWorkConfig
    | EditBindingConfig
    | NonceIntegrityConfig
    | QuorumParityConfig
    | CommitteeBindingConfig
    | CommitLockConfig
    | FinalityProofsConfig
    | UnpinnedCommitteeConfig
    | IdentityCarryoverConfig
    | NetworkGovernanceConfig
    | TxTypeAllowListConfig
    | InstantMessagingBindingConfig
    | NativeSendBindingConfig
    | CanonicalAddressesConfig
    | FeeBindingConfig
    | BlockCapsConfig
    | TokenStakingGateConfig
    | TokenStakingConfig
    | TelegramSenderBindingConfig
    | XmRemoveCanonicalConfig
    | L2psSettlementConfig

/**
 * Centralized registry of known fork names. Keeping this as a literal union
 * means typos surface at compile time rather than being silently treated as
 * "unknown fork → inactive".
 */
export type ForkName =
    | "osDenomination"
    | "gasFeeSeparation"
    | "nonceEnforcement"
    | "signatureDomain"
    | "web2ProofBinding"
    | "xmProofBinding"
    | "tlsnProofEnforcement"
    | "atomicWork"
    | "editBinding"
    | "nonceIntegrity"
    | "quorumParity"
    | "committeeBinding"
    | "commitLock"
    | "finalityProofs"
    | "unpinnedCommittee"
    | "identityCarryover"
    | "stakeApplyChecks"
    | "networkGovernance"
    | "txTypeAllowList"
    | "instantMessagingBinding"
    | "nativeSendBinding"
    | "canonicalAddresses"
    | "feeBinding"
    | "blockCaps"
    | "tokenStakingGate"
    | "tokenStaking"
    | "telegramSenderBinding"
    | "xmRemoveCanonical"
    | "l2psSettlement"

/**
 * Per-fork type map. Used by the loader and gates to narrow the union by
 * fork name without runtime type checks.
 */
export interface ForkConfigByName {
    osDenomination: OsDenominationConfig
    gasFeeSeparation: GasFeeSeparationConfig
    nonceEnforcement: NonceEnforcementConfig
    signatureDomain: SignatureDomainConfig
    web2ProofBinding: Web2ProofBindingConfig
    xmProofBinding: XmProofBindingConfig
    tlsnProofEnforcement: TlsnProofEnforcementConfig
    atomicWork: AtomicWorkConfig
    editBinding: EditBindingConfig
    nonceIntegrity: NonceIntegrityConfig
    quorumParity: QuorumParityConfig
    committeeBinding: CommitteeBindingConfig
    commitLock: CommitLockConfig
    finalityProofs: FinalityProofsConfig
    unpinnedCommittee: UnpinnedCommitteeConfig
    identityCarryover: IdentityCarryoverConfig
    stakeApplyChecks: StakeApplyChecksConfig
    networkGovernance: NetworkGovernanceConfig
    txTypeAllowList: TxTypeAllowListConfig
    instantMessagingBinding: InstantMessagingBindingConfig
    nativeSendBinding: NativeSendBindingConfig
    canonicalAddresses: CanonicalAddressesConfig
    feeBinding: FeeBindingConfig
    blockCaps: BlockCapsConfig
    tokenStakingGate: TokenStakingGateConfig
    tokenStaking: TokenStakingConfig
    telegramSenderBinding: TelegramSenderBindingConfig
    xmRemoveCanonical: XmRemoveCanonicalConfig
    l2psSettlement: L2psSettlementConfig
}

/**
 * Placeholder treasury address used when no genesis payload is supplied.
 * DEM-665: chain-wipe operators replace this with the real treasury hex
 * before sealing genesis. A node booting with the placeholder treasury
 * is bit-identical to a pre-fork node only while
 * `gasFeeSeparation.activationHeight === null` — once active, treasury
 * fees would land here, so it MUST be replaced before activation.
 *
 * Format: lowercase hex, `0x` + 64 zero hex digits. Same shape (and the
 * same value, deliberately) as the burn address constant in
 * `migrations/gasFeeSeparation.ts`. Distinguishing the two by value is
 * intentional in production genesis; sharing the zero address in the
 * placeholder is purely a syntactic default — the loader rejects this
 * value when `activationHeight !== null`.
 */
export const PLACEHOLDER_TREASURY_ADDRESS =
    "0x" + "0".repeat(64)

/**
 * Chain ids of the testnet (data/genesis.json) and the devnets. Signatures
 * bind to the chain id once signatureDomain is on, so a mainnet that shares
 * one would accept transactions signed for that network.
 */
export const NON_MAINNET_CHAIN_IDS: readonly number[] = [1, 1337]

/**
 * Default fork configuration.
 *
 * `osDenomination` defaults to `activationHeight: 0` — fresh chains
 * boot post-fork by default. Rationale: every Demos chain shipped via
 * `./run -b true` / `wipe_and_reboot.sh` / docker --clean is a brand-new
 * chain with no pre-fork peers to maintain wire compatibility with. The
 * previous default (`null`) was a backwards-compatibility hedge for the
 * incentives-campaign testnet that crossed the fork mid-flight; that
 * window has closed. Operators upgrading an existing pre-fork chain
 * MUST still pin `activationHeight: <future block>` explicitly in
 * `data/genesis.json.forks.osDenomination` and roll the upgrade in
 * lock-step with their peers — overriding the default to `null` is
 * supported and remains the safe path for a live cross-fork upgrade.
 *
 * `gasFeeSeparation` stays inactive by default because its activation
 * also requires a real treasury address — the placeholder zero address
 * is rejected by the loader when `activationHeight !== null`. Operators
 * who want this fork active on a fresh chain set both fields explicitly.
 *
 * Genesis can override any entry via `genesisData.forks`.
 */
export const DEFAULT_FORK_CONFIG: ForkConfigByName = {
    osDenomination: {
        activationHeight: 0,
        description:
            "DEM→OS denomination change. amount field becomes OS string.",
    },
    gasFeeSeparation: {
        // Active from genesis on fresh chains (mirrors osDenomination /
        // nonceEnforcement height-0 default). Requires a REAL treasury — the
        // loader rejects the placeholder zero address when activationHeight is
        // set, to avoid routing fees into the burn address. Genesis may
        // override both fields per deployment.
        activationHeight: 0,
        description:
            "Gas fee separation (DEM-665). Splits gas into network/rpc/additional " +
            "components with per-component burn/treasury/rpc-operator distribution.",
        treasuryAddress:
            "0xc1b0048492ab1496b94413c9b7b24a89c19552ca7d18d85a8b2d0ca733d8eaa3",
    },
    tlsnProofEnforcement: {
        // Inactive by default, and deliberately so. A running chain's genesis
        // predates this entry, and a missing entry hydrates from here — so a
        // height-0 default would switch the rule on the moment the binary is
        // upgraded. Every presentation the current verifier produces carries
        // the structure-only marker, which means every TLSN identity
        // assignment on that chain would start failing, with no coordination
        // and no way back short of a downgrade. A fresh chain that wants the
        // rule from block 0, and a live chain that has scheduled its
        // switchover, both say so in genesis.
        activationHeight: null,
        description:
            "Reject TLSNotary identity claims while the node only structure-checks the " +
            "presentation — the claim's own bytes are the only evidence behind it.",
    },
    web2ProofBinding: {
        // Inactive by default: the bound shape has to be out in clients
        // before proofs signed the old way stop verifying.
        activationHeight: null,
        description:
            "Web2 identity proofs sign demos-web2:v1:<context>:<username>:<sender>, " +
            "so a published proof cannot be reused to claim another handle.",
    },
    xmProofBinding: {
        // Inactive by default: wallets and SDKs have to sign the bound
        // message before proofs signed the old way stop verifying.
        activationHeight: null,
        description:
            "Cross-chain identity proofs sign demos-xm:v1:<chain>:<address>:<sender>:<issuedAt>, " +
            "so an old signature by the wallet cannot be replayed as a proof.",
    },
    signatureDomain: {
        // Inactive by default even on fresh chains: every signer in the
        // ecosystem (node, SDK, wallet) has to ship the new preimage before a
        // chain switches, or in-flight transactions stop verifying. Set an
        // explicit height once the clients are out.
        activationHeight: null,
        description:
            "Transaction signatures cover demos-tx:v1:<chainId>:<hash> instead of the " +
            "bare hash: a message signature can no longer stand in for a transaction " +
            "signature, and a transaction cannot replay onto another chain.",
    },
    nonceEnforcement: {
        // Active from genesis on fresh chains (audit C5). Mirrors
        // osDenomination's height-0 default: a brand-new chain boots fully
        // post-fork. Genesis can still override per-deployment. Existing
        // chains that need a coordinated mid-chain activation set an explicit
        // future height in their genesis instead.
        activationHeight: 0,
        description:
            "Per-sender nonce checks at admission (audit-sweep batch C + C5): a nonce at or " +
            "below the confirmed one is refused. Paired with the native forged-edit guard and " +
            "confirmed-tx-hash uniqueness at apply time.",
    },
    atomicWork: {
        // Dormant everywhere, including fresh chains: the substrate is not
        // yet conformant, so activation is an explicit operator decision.
        activationHeight: null,
        description:
            "Atomic Works: Work edits (resource-slot CAS, attempt, receipt, " +
            "storage put) applied all-or-nothing in one transition.",
    },
    editBinding: {
        // Dormant by default, like every rule that refuses traffic a running
        // chain accepts today: a missing genesis entry hydrates from here, so
        // a height-0 default would switch it on at the binary upgrade with no
        // height agreed. A chain launched from genesis with this build sets 0.
        activationHeight: null,
        description:
            "Apply refuses a transaction whose edits differ from the ones regenerated " +
            "from its signed body, and an edit that acts on an account other than the sender's.",
    },
    nonceIntegrity: {
        // Dormant by default: it changes which transactions of a block apply
        // and what a failed one leaves, and a missing genesis entry hydrates
        // from here. A chain launched from genesis with this build sets 0.
        activationHeight: null,
        description:
            "Apply refuses a nonce that is not the sender's next one, a failed transaction " +
            "still spends its nonce, and every transaction ships exactly one +1 nonce edit on its sender.",
    },
    quorumParity: {
        // Dormant by default: blocks already on a running chain were synced
        // under the pool-relative quorum, and a missing genesis entry
        // hydrates from here. A chain launched from genesis with this build
        // sets 0.
        activationHeight: null,
        description:
            "Sync accepts a block only with 2/3 + 1 of a full committee's signatures, " +
            "the same quorum a producer needs to commit it.",
    },
    committeeBinding: {
        // Dormant by default: the committee rule changes which signatures
        // count, and a missing genesis entry hydrates from here. A chain
        // launched from genesis with this build sets 0.
        activationHeight: null,
        description:
            "The committee for a block is drawn from chain data alone, and only its " +
            "members' signatures count toward the block's quorum.",
    },
    commitLock: {
        // Dormant by default: it changes what a block's signatures sign, and
        // a missing genesis entry hydrates from here. A chain launched from
        // genesis with this build sets 0, together with committeeBinding.
        activationHeight: null,
        description:
            "Members prevote and precommit with the height and round in the signed message, " +
            "lock on a block with a proof of lock, and a block carries one round's precommits.",
    },
    finalityProofs: {
        // Dormant by default: it changes the hashed block content, and a
        // missing genesis entry hydrates from here. A chain launched from
        // genesis with this build sets 0.
        activationHeight: null,
        description:
            "A block commits its height, the result root of its parent's transactions and " +
            "the hash of its parent's validator set, so finality can be proven offline.",
    },
    identityCarryover: {
        // Dormant by default: it changes which first-link awards a block pays
        // and which links an unlink removes, and a missing genesis entry
        // hydrates from here. A mainnet genesis sets 0.
        activationHeight: null,
        description:
            "Genesis imports user data without balances, imported identities pay no " +
            "first-link award, and a web2 unlink removes one platform account by userId.",
    },
    stakeApplyChecks: {
        // Dormant by default: it changes what a stake, unstake and exit do to
        // balances and validator rows, and a missing genesis entry hydrates
        // from here. A mainnet genesis sets 0.
        activationHeight: null,
        description:
            "Apply debits a stake from the balance and refunds it once at exit, checks the " +
            "minimum stake on entry, and refuses an unstake below the committee floor.",
    },
    networkGovernance: {
        // Dormant by default and at launch: a missing genesis entry hydrates
        // from here, so governance stays off until a height is agreed.
        activationHeight: null,
        description:
            "Admit and apply networkUpgrade and networkUpgradeVote transactions, each " +
            "governance edit bound to the account that signed it.",
    },
    txTypeAllowList: {
        // Dormant by default: a missing genesis entry hydrates from here, so a
        // running chain keeps applying its history as before.
        activationHeight: null,
        description:
            "Admit and apply only the transaction types the node implements; escrow, " +
            "contract, token and unknown types are refused instead of applied as a fee.",
    },
    instantMessagingBinding: {
        // Dormant by default: a missing genesis entry hydrates from here, so a
        // running chain keeps applying its history as before.
        activationHeight: null,
        description:
            "A fee-free instantMessaging transaction (no edits) is merged and applied only " +
            "when a validator staked at the tip signed it.",
    },
    nativeSendBinding: {
        // Dormant by default: it changes which transactions a block applies,
        // and a missing genesis entry hydrates from here. A mainnet genesis
        // sets 0.
        activationHeight: null,
        description:
            "A native send pays the recipient and amount its signed body names: its args " +
            "must equal content.to and content.amount.",
    },
    canonicalAddresses: {
        // Dormant by default, as above. A mainnet genesis sets 0.
        activationHeight: null,
        description:
            "Accounts are keyed by lowercase hex: a sender, recipient or balance edit " +
            "account spelled with upper-case digits is refused.",
    },
    feeBinding: {
        // Dormant by default, as above. A mainnet genesis sets 0.
        activationHeight: null,
        description:
            "A native transaction's shipped fee equals the network fee and names no " +
            "rpc_address, checked at admission and apply, not only at RPC confirm.",
    },
    blockCaps: {
        // Dormant by default: it changes which txs a block contains, and a
        // missing genesis entry hydrates from here. A chain launched from
        // genesis with this build sets 0.
        activationHeight: null,
        description:
            "A block takes a bounded, deterministic share of the pool by tx count and " +
            "content bytes, and the mempool merge holds each sender to the admission cap.",
    },
    tokenStakingGate: {
        // Dormant by default: it refuses stakes a running chain accepts, and a
        // missing genesis entry hydrates from here, so a running chain keeps
        // staking open. A mainnet genesis sets 0.
        activationHeight: null,
        description:
            "Validators come from the genesis list: validatorStake and validatorUnstake " +
            "are refused until tokenStaking opens token staking.",
    },
    tokenStaking: {
        // Dormant by default and at launch: token staking opens by a later
        // height-pinned activation. Changes nothing without tokenStakingGate.
        activationHeight: null,
        description:
            "Token staking opens by network upgrade: validatorStake and validatorUnstake " +
            "are admitted and applied again under tokenStakingGate.",
    },
    unpinnedCommittee: {
        // Dormant by default: a missing genesis entry hydrates from here, and
        // the testnet's committees still put the pinned identities first. A
        // chain launched from genesis with this build sets 0.
        activationHeight: null,
        description:
            "No identity is guaranteed a committee seat: the pinned validator keys are " +
            "drawn by the seed like every other member.",
    },
    telegramSenderBinding: {
        // Dormant by default: it changes which identity edits a block
        // applies, and a missing genesis entry hydrates from here. A mainnet
        // genesis sets 0.
        activationHeight: null,
        description:
            "A Telegram identity attestation links only to the account whose key " +
            "signed its challenge, the transaction sender.",
    },
    xmRemoveCanonical: {
        // Dormant by default: it changes which entry an xm remove takes, and a
        // missing genesis entry hydrates from here. A mainnet genesis sets 0.
        activationHeight: null,
        description:
            "An xm identity remove finds the stored entry by the chain's canonical " +
            "address form, as admission compares them.",
    },
    l2psSettlement: {
        // Dormant by default: it changes the balances an l2psBatch moves, and
        // a missing genesis entry hydrates from here. A mainnet genesis sets 0.
        activationHeight: null,
        description:
            "An l2psBatch settles on every node through a proven net-change record; " +
            "the entry node's local L2PS proof path is off.",
    },
}

/**
 * Deep-copy helper for the default config. The default object is exported
 * as a constant for documentation purposes; runtime state must own its own
 * copy so per-instance mutation (e.g. genesis loading) does not leak into
 * the module-level constant.
 */
export function cloneDefaultForkConfig(): ForkConfigByName {
    return {
        osDenomination: { ...DEFAULT_FORK_CONFIG.osDenomination },
        gasFeeSeparation: { ...DEFAULT_FORK_CONFIG.gasFeeSeparation },
        nonceEnforcement: { ...DEFAULT_FORK_CONFIG.nonceEnforcement },
        signatureDomain: { ...DEFAULT_FORK_CONFIG.signatureDomain },
        web2ProofBinding: { ...DEFAULT_FORK_CONFIG.web2ProofBinding },
        xmProofBinding: { ...DEFAULT_FORK_CONFIG.xmProofBinding },
        tlsnProofEnforcement: { ...DEFAULT_FORK_CONFIG.tlsnProofEnforcement },
        atomicWork: { ...DEFAULT_FORK_CONFIG.atomicWork },
        editBinding: { ...DEFAULT_FORK_CONFIG.editBinding },
        nonceIntegrity: { ...DEFAULT_FORK_CONFIG.nonceIntegrity },
        quorumParity: { ...DEFAULT_FORK_CONFIG.quorumParity },
        committeeBinding: { ...DEFAULT_FORK_CONFIG.committeeBinding },
        commitLock: { ...DEFAULT_FORK_CONFIG.commitLock },
        finalityProofs: { ...DEFAULT_FORK_CONFIG.finalityProofs },
        unpinnedCommittee: { ...DEFAULT_FORK_CONFIG.unpinnedCommittee },
        identityCarryover: { ...DEFAULT_FORK_CONFIG.identityCarryover },
        stakeApplyChecks: { ...DEFAULT_FORK_CONFIG.stakeApplyChecks },
        networkGovernance: { ...DEFAULT_FORK_CONFIG.networkGovernance },
        txTypeAllowList: { ...DEFAULT_FORK_CONFIG.txTypeAllowList },
        instantMessagingBinding: { ...DEFAULT_FORK_CONFIG.instantMessagingBinding },
        nativeSendBinding: { ...DEFAULT_FORK_CONFIG.nativeSendBinding },
        canonicalAddresses: { ...DEFAULT_FORK_CONFIG.canonicalAddresses },
        feeBinding: { ...DEFAULT_FORK_CONFIG.feeBinding },
        blockCaps: { ...DEFAULT_FORK_CONFIG.blockCaps },
        tokenStakingGate: { ...DEFAULT_FORK_CONFIG.tokenStakingGate },
        tokenStaking: { ...DEFAULT_FORK_CONFIG.tokenStaking },
        telegramSenderBinding: { ...DEFAULT_FORK_CONFIG.telegramSenderBinding },
        xmRemoveCanonical: { ...DEFAULT_FORK_CONFIG.xmRemoveCanonical },
        l2psSettlement: { ...DEFAULT_FORK_CONFIG.l2psSettlement },
    }
}
