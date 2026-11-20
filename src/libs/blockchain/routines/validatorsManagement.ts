// INFO Phase 0 staking lifecycle: stake, unstake-request, exit.
// Transaction routing for validatorStake / validatorUnstake / validatorExit
// lives in endpointExecution.ts; this module owns the validation rules that
// sit between the tx and the GCR edits that mutate the Validators table.

import forge from "node-forge"

import Chain from "src/libs/blockchain/chain"
import GCR from "../gcr/gcr"
import Transaction from "../transaction"
import { calculateFeeBreakdown } from "./calculateCurrentGas"
import { requireSender } from "src/libs/network/utils/txHelpers"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { isForkActive } from "@/forks"
import { TOKEN_STAKING_REFUSAL, tokenStakingOpen } from "@/forks/tokenStakingGate"
import { nftGatingActive } from "@/forks/nftValidatorGatingGate"
import { chainMinValidatorStake } from "src/features/staking/chainMinStake"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"
import type {
    ValidatorStakePayload,
    ValidatorChallengePayload,
    ValidatorNftProof,
    GCREditValidatorStake,
} from "src/features/staking/types"
import { isAllowlistedMint } from "src/features/staking/nftAllowlist"
import {
    verifyChallengeEvidence,
    verifyProofSupersedes,
    verifyCurrentOwner,
    verifyNftProof,
    type SolanaCheck,
    type SolanaReadOptions,
} from "src/features/staking/solanaProof"
import {
    challengeVerdictKey,
    refusedVerdict,
    rememberRefused,
    stakeVerdictKey,
} from "src/features/staking/seatAdmission"
import {
    DEFAULT_MIN_VALIDATOR_STAKE,
    UNSTAKE_LOCK_BLOCKS,
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "src/features/staking/constants"

/**
 * Current minimum stake required to register as a validator.
 *
 * Prefers the governance-driven value in `sharedState.networkParameters`;
 * falls back to the Phase-0 default when governance has not loaded yet
 * (e.g. during bootstrap before `loadNetworkParameters()` completes).
 */
export function getMinValidatorStake(): bigint {
    const governed = (
        getSharedState.networkParameters as {
            minValidatorStake?: string
        } | null
    )?.minValidatorStake
    if (typeof governed === "string" && governed.length > 0) {
        try {
            return BigInt(governed)
        } catch {
            /* fall through */
        }
    }
    return BigInt(DEFAULT_MIN_VALIDATOR_STAKE)
}

/** Whether `stakeApplyChecks` holds for the block applied on the current tip. */
async function stakeChecksActive(): Promise<boolean> {
    return isForkActive("stakeApplyChecks", await Chain.getLastBlockNumber())
}

/** Whether token staking is open for the block applied on the current tip. */
async function stakingOpen(): Promise<boolean> {
    return tokenStakingOpen(await Chain.getLastBlockNumber())
}

/** Whether `nftValidatorGating` holds for the block applied on the current tip. */
async function nftGating(): Promise<boolean> {
    return nftGatingActive(await Chain.getLastBlockNumber())
}

/**
 * `unreachable` marks a verdict that no Solana endpoint could answer: the
 * tx is neither accepted nor known bad, and a consensus caller leaves it
 * out of its candidate without treating it as invalid.
 */
export type StakeTxResult = { valid: boolean; message: string; unreachable?: boolean }

function parseStakeTx(tx: Transaction):
    | { valid: true; payload: ValidatorStakePayload; sender: string; amount: bigint }
    | { valid: false; result: StakeTxResult } {
    const payload = extractStakePayload(tx, false)
    if (!payload) {
        return { valid: false, result: { valid: false, message: "Missing stake payload" } }
    }

    const sender = requireSender(tx)
    if (!sender) return { valid: false, result: { valid: false, message: "Missing sender" } }

    let amount: bigint
    try {
        amount = BigInt(payload.amount)
    } catch {
        return { valid: false, result: { valid: false, message: "Invalid stake amount encoding" } }
    }
    if (amount <= 0n) {
        return { valid: false, result: { valid: false, message: "Stake amount must be positive" } }
    }

    return { valid: true, payload, sender, amount }
}

export default class ValidatorsManagement {
    // ------------------------------------------------------------------
    // Tx validation entry points
    // ------------------------------------------------------------------

    /**
     * Validate a `validatorStake` tx: either a new-validator entrance or an
     * increase-stake operation on an existing validator.
     */
    static async manageValidatorStakeTx(
        tx: Transaction,
        options: SolanaReadOptions = {},
    ): Promise<StakeTxResult> {
        if (!(await stakingOpen())) {
            return { valid: false, message: TOKEN_STAKING_REFUSAL }
        }
        if (await nftGating()) return ValidatorsManagement.manageNftSeatStakeTx(tx, options)
        const parsed = parseStakeTx(tx)
        if (parsed.valid === false) return parsed.result
        const { payload, sender, amount } = parsed

        const existing = await GCR.getGCRValidatorStatus(sender)
        const bonding = await stakeChecksActive()
        const min = bonding
            ? maxOf(getMinValidatorStake(), chainMinValidatorStake())
            : getMinValidatorStake()

        if (bonding) {
            return checkBondedStake(
                existing,
                amount,
                payload.connectionUrl,
                min,
                await GCR.getAccountBalance(sender),
                BigInt((await calculateFeeBreakdown(tx)).total),
            )
        }

        // The stake must be backed by funds: the cumulative staked amount
        // after this tx (prior stake + increase) plus the tx gas fee must
        // be covered by the sender's balance. The stake itself is not
        // debited in Phase 0, so checking only the increase would let two
        // sequential stakes each pass against the same balance and push
        // the staked total above what the account holds.
        let priorStake: bigint
        try {
            priorStake = BigInt(existing?.staked_amount ?? "0")
        } catch {
            return {
                valid: false,
                message: `Invalid persisted staked_amount=${existing?.staked_amount}`,
            }
        }
        const balance = await GCR.getAccountBalance(sender)
        const gasFee = BigInt((await calculateFeeBreakdown(tx)).total)
        const totalStake = priorStake + amount
        if (balance < totalStake + gasFee) {
            return {
                valid: false,
                message: `Insufficient balance for stake: total stake ${totalStake} (existing ${priorStake} + new ${amount}) + gas ${gasFee} exceeds balance ${balance}`,
            }
        }

        if (!existing) {
            // New validator registration
            if (amount < min) {
                return {
                    valid: false,
                    message: `Initial stake ${amount} below minimum ${min}`,
                }
            }
            if (!payload.connectionUrl) {
                return {
                    valid: false,
                    message: "connectionUrl required for first stake",
                }
            }
            return { valid: true, message: "Validator entrance valid" }
        }

        if (
            existing.status !== VALIDATOR_STATUS_ACTIVE &&
            existing.status !== VALIDATOR_STATUS_UNSTAKING
        ) {
            return {
                valid: false,
                message: `Validator not eligible for stake top-up (status=${existing.status})`,
            }
        }
        return { valid: true, message: "Validator stake increase valid" }
    }

    /**
     * A `validatorStake` under `nftValidatorGating`: the seat is backed by an
     * NFT, not by DEM, so the amount is 0 and entering the set takes a proof.
     */
    static async manageNftSeatStakeTx(
        tx: Transaction,
        options: SolanaReadOptions = {},
    ): Promise<StakeTxResult> {
        const payload = extractStakePayload(tx)
        if (!payload) {
            return { valid: false, message: "Missing stake payload" }
        }

        const sender = requireSender(tx)
        if (!sender) return { valid: false, message: "Missing sender" }

        let amount: bigint
        try {
            amount = BigInt(payload.amount)
        } catch {
            return { valid: false, message: "Invalid stake amount encoding" }
        }
        if (amount !== 0n) {
            return { valid: false, message: "Stake amount must be 0; a seat is backed by its NFT" }
        }

        const existing = await GCR.getGCRValidatorStatus(sender)
        const entering = !existing || existing.status === VALIDATOR_STATUS_EXITED
        if (
            !entering &&
            existing.status !== VALIDATOR_STATUS_ACTIVE &&
            existing.status !== VALIDATOR_STATUS_UNSTAKING
        ) {
            return {
                valid: false,
                message: `Validator not eligible for stake (status=${existing.status})`,
            }
        }

        if (entering) {
            if (!payload.connectionUrl && !existing?.connection_url) {
                return {
                    valid: false,
                    message: "connectionUrl required for first stake",
                }
            }
            const nft = await ValidatorsManagement.checkEntranceNft(
                payload.nft,
                sender,
                tx.content.timestamp,
                options,
            )
            if (!nft.valid) return nft
            return { valid: true, message: `Validator entrance valid (${nft.message})` }
        }

        // A proof on a top-up is never checked against Solana, so one must
        // not ride in and be recorded as the seat's NFT.
        if (payload.nft !== undefined) {
            return {
                valid: false,
                message: "A top-up cannot carry an NFT proof",
            }
        }
        return { valid: true, message: "Validator stake increase valid" }
    }

    /**
     * The NFT rules for a stake that takes a seat: a proof is present, its
     * mint is allowlisted and free, the proof checks out on Solana, and the
     * wallet still holds the NFT. A `fresh` caller also skips the held
     * refusals: one may say the wallet no longer held the NFT minutes ago,
     * and members that did not admit the tx would read the chain as it is now.
     */
    static async checkEntranceNft(
        nft: ValidatorNftProof | undefined,
        sender: string,
        txTimestampMs: number,
        options: SolanaReadOptions = {},
    ): Promise<StakeTxResult> {
        if (nft === undefined) {
            return {
                valid: false,
                message: "An allowlisted node NFT proof is required to become a validator",
            }
        }
        if (!isAllowlistedMint(nft.mint)) {
            return { valid: false, message: `NFT ${nft.mint} is not eligible` }
        }
        const validator = sender.startsWith("0x") ? sender : `0x${sender}`
        const verdictKey = stakeVerdictKey(nft.proofTx, validator)
        const held = options.fresh ? null : refusedVerdict(verdictKey)
        if (held !== null) return { valid: false, message: held }
        const proof = await verifyNftProof(nft, validator, txTimestampMs, undefined, options)
        if (proof.status !== "valid") return judged(proof, "NFT proof", verdictKey)
        const owner = await verifyCurrentOwner(nft.mint, nft.owner, options)
        if (owner.status !== "valid") return judged(owner, "NFT ownership", verdictKey)
        // Another seat backed by this mint is evicted when the stake applies;
        // the new proof must be later than the one that seat was taken with.
        const holder = await GCR.getGCRValidatorByMint(nft.mint)
        if (holder && holder.address !== sender) {
            if (holder.nft_proof_tx) {
                const order = await verifyProofSupersedes(proof.slot, holder.nft_proof_tx, options)
                if (order.status !== "valid") return judged(order, "NFT proof", verdictKey)
            }
            return { valid: true, message: `NFT proof valid; evicts ${holder.address}` }
        }
        return { valid: true, message: "NFT proof valid" }
    }

    /**
     * Validate a `validatorChallenge` tx: the target holds a seat backed by
     * an NFT, and the evidence is a finalized transfer of that NFT out of
     * the recorded wallet after the proof.
     */
    static async manageValidatorChallengeTx(
        tx: Transaction,
        options: SolanaReadOptions = {},
    ): Promise<StakeTxResult> {
        if (!(await nftGating())) {
            return { valid: false, message: "validatorChallenge is not active on this network" }
        }
        const sender = requireSender(tx)
        if (!sender) return { valid: false, message: "Missing sender" }
        const payload = extractChallengePayload(tx)
        if (!payload) {
            return { valid: false, message: "Missing challenge payload" }
        }
        const target = await GCR.getGCRValidatorStatus(payload.validator)
        if (!target) return { valid: false, message: "Challenged validator not found" }
        if (
            target.status !== VALIDATOR_STATUS_ACTIVE &&
            target.status !== VALIDATOR_STATUS_UNSTAKING
        ) {
            return {
                valid: false,
                message: `Challenged validator holds no seat (status=${target.status})`,
            }
        }
        if (!target.nft_mint || !target.nft_owner || !target.nft_proof_tx) {
            return { valid: false, message: "Challenged validator has no NFT on record" }
        }
        if (payload.proofTx !== target.nft_proof_tx) {
            return {
                valid: false,
                message: `Challenge names proof ${payload.proofTx}, but the seat rests on ${target.nft_proof_tx}`,
            }
        }
        // Apply refuses an eviction that would leave no committee, so the
        // challenge is refused here before it costs a Solana read.
        if (target.status === VALIDATOR_STATUS_ACTIVE) {
            const floor = await activeFloorRefusal("Eviction")
            if (floor) return { valid: false, message: floor }
        }
        const verdictKey = challengeVerdictKey(
            payload.evidenceTx,
            target.nft_proof_tx,
            payload.validator,
        )
        const held = options.fresh ? null : refusedVerdict(verdictKey)
        if (held !== null) return { valid: false, message: held }
        const evidence = await verifyChallengeEvidence(
            payload.evidenceTx,
            {
                mint: target.nft_mint,
                owner: target.nft_owner,
                proofTx: target.nft_proof_tx,
            },
            options,
        )
        if (evidence.status !== "valid") {
            return judged(evidence, "Challenge evidence", verdictKey)
        }
        return { valid: true, message: "Challenge valid" }
    }

    /**
     * Validate a `validatorUnstake` tx — the sender is an active validator
     * and does not already have an unstake in progress.
     */
    static async manageValidatorUnstakeTx(
        tx: Transaction,
    ): Promise<StakeTxResult> {
        if (!(await stakingOpen())) {
            return { valid: false, message: TOKEN_STAKING_REFUSAL }
        }
        const sender = requireSender(tx)
        if (!sender) return { valid: false, message: "Missing sender" }

        const validator = await GCR.getGCRValidatorStatus(sender)
        if (!validator) {
            return { valid: false, message: "Not a validator" }
        }
        if (validator.status !== VALIDATOR_STATUS_ACTIVE) {
            return {
                valid: false,
                message: `Validator not active (status=${validator.status})`,
            }
        }
        if (validator.unstake_requested_at !== null && validator.unstake_requested_at !== undefined) {
            return {
                valid: false,
                message: "Unstake already requested",
            }
        }
        // Apply holds an unstake to the floor under either fork.
        if ((await stakeChecksActive()) || (await nftGating())) {
            const floor = await activeFloorRefusal("Unstake")
            if (floor) return { valid: false, message: floor }
        }
        return { valid: true, message: "Unstake valid" }
    }

    /**
     * Validate a `validatorExit` tx — the sender requested unstake and their
     * lock period has elapsed.
     */
    static async manageValidatorExitTx(
        tx: Transaction,
    ): Promise<StakeTxResult> {
        const sender = requireSender(tx)
        if (!sender) return { valid: false, message: "Missing sender" }

        const validator = await GCR.getGCRValidatorStatus(sender)
        if (!validator) {
            return { valid: false, message: "Not a validator" }
        }
        if (validator.status !== VALIDATOR_STATUS_UNSTAKING) {
            return {
                valid: false,
                message: `Validator must be unstaking before exit (status=${validator.status})`,
            }
        }
        const availableAt = validator.unstake_available_at
        if (availableAt === null || availableAt === undefined) {
            return {
                valid: false,
                message: "Must call validatorUnstake first",
            }
        }
        const currentBlock = await Chain.getLastBlockNumber()
        if (currentBlock < availableAt) {
            return {
                valid: false,
                message: `Lock not elapsed: ${currentBlock} < ${availableAt}`,
            }
        }
        return { valid: true, message: "Exit valid" }
    }

    // ------------------------------------------------------------------
    // GCR-edit builders — invoked from the tx-derivation stage so the edit
    // is embedded in the signed transaction and applied atomically at
    // confirmation time.
    // ------------------------------------------------------------------

    static buildStakeEdit(
        account: string,
        amount: string,
        connectionUrl: string,
        txhash: string,
    ): GCREditValidatorStake {
        return {
            type: "validatorStake",
            isRollback: false,
            account,
            operation: "stake",
            amount,
            connectionUrl,
            txhash,
        }
    }

    static buildUnstakeEdit(
        account: string,
        txhash: string,
    ): GCREditValidatorStake {
        return {
            type: "validatorStake",
            isRollback: false,
            account,
            operation: "unstake",
            amount: "0",
            txhash,
        }
    }

    static buildExitEdit(
        account: string,
        txhash: string,
    ): GCREditValidatorStake {
        return {
            type: "validatorStake",
            isRollback: false,
            account,
            operation: "exit",
            amount: "0",
            txhash,
        }
    }

    // ------------------------------------------------------------------
    // Observational helpers preserved from the old API
    // ------------------------------------------------------------------

    static async isValidatorActive(publicKey: forge.pki.ed25519.BinaryBuffer) {
        const hexKey = Buffer.from(publicKey as Uint8Array).toString("hex")
        const validator = await GCR.getGCRValidatorStatus(hexKey)
        if (!validator) return false
        return validator.status === VALIDATOR_STATUS_ACTIVE
    }

    static async manageValidatorOnlineStatus(
        publicKey: forge.pki.ed25519.BinaryBuffer,
    ) {
        const hexKey = Buffer.from(publicKey as Uint8Array).toString("hex")
        const validator = await GCR.getGCRValidatorStatus(hexKey)
        if (!validator) return
        log.debug(
            `[Validators] online-status probe for ${hexKey} (url=${validator.connection_url})`,
        )
        // TODO: connection test (legacy TODO carried over).
    }
}

/**
 * Why taking one validator out of the active set at the tip would leave
 * fewer than the committee floor, or null.
 */
async function activeFloorRefusal(what: string): Promise<string | null> {
    const active = (
        (await GCR.getGCRValidatorsAtBlock(await Chain.getLastBlockNumber())) as unknown[]
    ).length
    const floor = quorumThreshold(getSharedState.shardSize)
    if (active - 1 < floor) {
        return `${what} would leave ${active - 1} active validators, below the committee floor of ${floor}`
    }
    return null
}

/**
 * `fromCheck`, holding a refusal under `verdictKey` so the same proof or
 * evidence is not read from Solana again while it stays refused.
 */
function judged(check: SolanaCheck, what: string, verdictKey: string): StakeTxResult {
    const result = fromCheck(check, what)
    if (!result.valid && !result.unreachable) rememberRefused(verdictKey, result.message)
    return result
}

/** A tx verdict from a Solana check, keeping "unreachable" distinct from "invalid". */
function fromCheck(check: SolanaCheck, what: string): StakeTxResult {
    if (check.status === "unreachable") {
        return {
            valid: false,
            unreachable: true,
            message: `${what} could not be verified: ${check.reason}`,
        }
    }
    if (check.status === "invalid") {
        return { valid: false, message: `${what} rejected: ${check.reason}` }
    }
    return { valid: true, message: `${what} valid` }
}

function maxOf(a: bigint, b: bigint): bigint {
    return a > b ? a : b
}

/**
 * Admission rule for a stake under `stakeApplyChecks`, where the stake leaves
 * the balance: the balance covers this stake and the fee, and entering the
 * set (new, or after an exit) takes the minimum and a connection URL.
 */
function checkBondedStake(
    existing: { status: string | null; connection_url: string | null } | null,
    amount: bigint,
    connectionUrl: string,
    min: bigint,
    balance: bigint,
    gasFee: bigint,
): StakeTxResult {
    if (balance < amount + gasFee) {
        return {
            valid: false,
            message: `Insufficient balance for stake: ${amount} + gas ${gasFee} exceeds balance ${balance}`,
        }
    }
    const entering =
        !existing ||
        (existing.status !== VALIDATOR_STATUS_ACTIVE &&
            existing.status !== VALIDATOR_STATUS_UNSTAKING)
    if (!entering) {
        return { valid: true, message: "Validator stake increase valid" }
    }
    if (amount < min) {
        return {
            valid: false,
            message: `Initial stake ${amount} below minimum ${min}`,
        }
    }
    if (!connectionUrl && !existing?.connection_url) {
        return { valid: false, message: "connectionUrl required for first stake" }
    }
    return { valid: true, message: "Validator entrance valid" }
}

/**
 * Pull the `ValidatorStakePayload` out of a tx, or return null if malformed.
 * The NFT proof is read only under `nftValidatorGating`; before it the
 * payload is judged as it always was.
 */
function extractStakePayload(
    tx: Transaction,
    withNft = true,
): ValidatorStakePayload | null {
    const data = tx.content?.data as unknown as [string, unknown] | undefined
    if (!Array.isArray(data) || data.length < 2) return null
    const payload = data[1]
    if (!payload || typeof payload !== "object") return null
    const { amount, connectionUrl, nft } = payload as Partial<ValidatorStakePayload>
    if (typeof amount !== "string") return null
    const out: ValidatorStakePayload = {
        amount,
        connectionUrl: typeof connectionUrl === "string" ? connectionUrl : "",
    }
    if (withNft && nft !== undefined) {
        if (
            nft === null ||
            typeof nft !== "object" ||
            typeof nft.mint !== "string" ||
            typeof nft.owner !== "string" ||
            typeof nft.proofTx !== "string"
        ) {
            return null
        }
        out.nft = { mint: nft.mint, owner: nft.owner, proofTx: nft.proofTx }
    }
    return out
}

/** Pull the `ValidatorChallengePayload` out of a tx, or return null if malformed. */
function extractChallengePayload(
    tx: Transaction,
): ValidatorChallengePayload | null {
    const data = tx.content?.data as unknown as [string, unknown] | undefined
    if (!Array.isArray(data) || data.length < 2) return null
    const payload = data[1]
    if (!payload || typeof payload !== "object") return null
    const { validator, evidenceTx, proofTx } = payload as Partial<ValidatorChallengePayload>
    if (typeof validator !== "string" || typeof evidenceTx !== "string" || typeof proofTx !== "string") {
        return null
    }
    return { validator: validator.toLowerCase(), evidenceTx, proofTx }
}
