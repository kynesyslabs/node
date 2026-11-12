// INFO Phase 0 staking lifecycle: stake, unstake-request, exit.
// Transaction routing for validatorStake / validatorUnstake / validatorExit
// lives in endpointExecution.ts; this module owns the validation rules that
// sit between the tx and the GCR edits that mutate the Validators table.

import Chain from "src/libs/blockchain/chain"
import GCR from "../gcr/gcr"
import Transaction from "../transaction"
import { requireSender } from "src/libs/network/utils/txHelpers"
import type {
    ValidatorStakePayload,
    ValidatorChallengePayload,
    ValidatorNftProof,
} from "src/features/staking/types"
import { isAllowlistedMint } from "src/features/staking/nftAllowlist"
import {
    verifyChallengeEvidence,
    verifyProofSupersedes,
    verifyCurrentOwner,
    verifyNftProof,
    type SolanaCheck,
} from "src/features/staking/solanaProof"
import {
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "src/features/staking/constants"

/**
 * `unreachable` marks a verdict that no Solana endpoint could answer: the
 * tx is neither accepted nor known bad, and a consensus caller leaves it
 * out of its candidate without treating it as invalid.
 */
export type StakeTxResult = { valid: boolean; message: string; unreachable?: boolean }

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

        const entering =
            !existing || existing.status === VALIDATOR_STATUS_EXITED

        if (entering) {
            // New validator registration, or re-entry after an exit
            if (!payload.connectionUrl) {
                return {
                    valid: false,
                    message: "connectionUrl required for first stake",
                }
            }
            const nft = await ValidatorsManagement.checkEntranceNft(
                payload.nft,
                sender,
                tx.content.timestamp,
            )
            if (!nft.valid) return nft
            return { valid: true, message: `Validator entrance valid (${nft.message})` }
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
        // A proof on a top-up is never checked against Solana, and the apply
        // step treats any exited row as an entrance, so one must not ride in.
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
     * wallet still holds the NFT.
     */
    static async checkEntranceNft(
        nft: ValidatorNftProof | undefined,
        sender: string,
        txTimestampMs: number,
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
        const proof = await verifyNftProof(nft, validator, txTimestampMs)
        if (proof.status !== "valid") return fromCheck(proof, "NFT proof")
        const owner = await verifyCurrentOwner(nft.mint, nft.owner)
        if (owner.status !== "valid") return fromCheck(owner, "NFT ownership")
        // Another seat backed by this mint is evicted when the stake applies;
        // the new proof must be later than the one that seat was taken with.
        const holder = await GCR.getGCRValidatorByMint(nft.mint)
        if (holder && holder.address !== sender) {
            if (holder.nft_proof_tx) {
                const order = await verifyProofSupersedes(proof.slot, holder.nft_proof_tx)
                if (order.status !== "valid") return fromCheck(order, "NFT proof")
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
    ): Promise<StakeTxResult> {
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
        const evidence = await verifyChallengeEvidence(payload.evidenceTx, {
            mint: target.nft_mint,
            owner: target.nft_owner,
            proofTx: target.nft_proof_tx,
        })
        if (evidence.status !== "valid") return fromCheck(evidence, "Challenge evidence")
        return { valid: true, message: "Challenge valid" }
    }

    /**
     * Validate a `validatorUnstake` tx — the sender is an active validator
     * and does not already have an unstake in progress.
     */
    static async manageValidatorUnstakeTx(
        tx: Transaction,
    ): Promise<StakeTxResult> {
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

/** Pull the `ValidatorStakePayload` out of a tx, or return null if malformed. */
function extractStakePayload(tx: Transaction): ValidatorStakePayload | null {
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
    if (nft !== undefined) {
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

