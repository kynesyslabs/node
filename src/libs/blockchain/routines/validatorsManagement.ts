// INFO Phase 0 staking lifecycle: stake, unstake-request, exit.
// Transaction routing for validatorStake / validatorUnstake / validatorExit
// lives in endpointExecution.ts; this module owns the validation rules that
// sit between the tx and the GCR edits that mutate the Validators table.

import forge from "node-forge"

import Chain from "src/libs/blockchain/chain"
import GCR from "../gcr/gcr"
import Transaction from "../transaction"
import log from "src/utilities/logger"
import type {
    ValidatorStakePayload,
    GCREditValidatorStake,
} from "src/features/staking/types"
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
 * Reads `getSharedState.networkParameters.minValidatorStake` once Phase 1
 * (governance) lands; for now returns the Phase-0 default.
 */
export function getMinValidatorStake(): bigint {
    return BigInt(DEFAULT_MIN_VALIDATOR_STAKE)
}

type StakeTxResult = { valid: boolean; message: string }

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
        if (amount <= 0n) {
            return { valid: false, message: "Stake amount must be positive" }
        }

        const existing = await GCR.getGCRValidatorStatus(sender)
        const min = getMinValidatorStake()

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

        if (existing.status === VALIDATOR_STATUS_EXITED) {
            return {
                valid: false,
                message:
                    "Validator has exited; register again with a fresh keypair",
            }
        }
        // Stake increase is always allowed on an active or unstaking validator.
        return { valid: true, message: "Validator stake increase valid" }
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

/** Pull the `ValidatorStakePayload` out of a tx, or return null if malformed. */
function extractStakePayload(tx: Transaction): ValidatorStakePayload | null {
    const data = tx.content?.data as unknown as [string, unknown] | undefined
    if (!Array.isArray(data) || data.length < 2) return null
    const payload = data[1]
    if (!payload || typeof payload !== "object") return null
    const { amount, connectionUrl } = payload as Partial<ValidatorStakePayload>
    if (typeof amount !== "string") return null
    return {
        amount,
        connectionUrl: typeof connectionUrl === "string" ? connectionUrl : "",
    }
}

function requireSender(tx: Transaction): string | null {
    const from = tx.content?.from
    if (typeof from === "string" && from.length > 0) return from
    const ed = tx.content?.from_ed25519_address
    if (typeof ed === "string" && ed.length > 0) return ed
    return null
}
