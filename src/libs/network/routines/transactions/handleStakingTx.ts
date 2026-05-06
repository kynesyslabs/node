import type { Transaction } from "@kynesyslabs/demosdk/types"
import ValidatorsManagement from "@/libs/blockchain/routines/validatorsManagement"
import { requireSender } from "@/libs/network/utils/txHelpers"
import log from "src/utilities/logger"

interface StakingTxResult {
    success: boolean
    message: string
}

/**
 * Phase 0 staking dispatcher — **policy-only validation**.
 *
 * Returns valid/invalid + a message. Does NOT mutate `tx.content.gcr_edits`.
 * Edits are derived deterministically from tx content by
 * `GCRGeneration.generate()` (shared between SDK clients and server) so that
 * the server-side hash comparison in `handleValidateTransaction` agrees
 * with the client's signature. Persistence happens at block-confirmation
 * via `GCRValidatorStakeRoutines.apply()` on every node.
 *
 * Called from `confirmTransaction` (RPC entry, before signing) so bad
 * tx is rejected before validityData is signed and broadcast.
 */
export async function handleStakingTx(
    tx: Transaction,
): Promise<StakingTxResult> {
    const type = tx.content.type
    const sender = requireSender(tx)
    if (!sender) {
        return { success: false, message: "Missing sender" }
    }

    const nodeTx = tx as unknown as Parameters<
        typeof ValidatorsManagement.manageValidatorStakeTx
    >[0]

    switch (type) {
        case "validatorStake": {
            const payload = extractStakePayload(tx)
            if (!payload) {
                return { success: false, message: "Missing stake payload" }
            }
            const r = await ValidatorsManagement.manageValidatorStakeTx(nodeTx)
            log.debug(
                `[handleStakingTx] validatorStake ${tx.hash ?? ""} → ${r.valid}: ${r.message}`,
            )
            return { success: r.valid, message: r.message }
        }
        case "validatorUnstake": {
            const r = await ValidatorsManagement.manageValidatorUnstakeTx(
                nodeTx,
            )
            return { success: r.valid, message: r.message }
        }
        case "validatorExit": {
            const r = await ValidatorsManagement.manageValidatorExitTx(nodeTx)
            return { success: r.valid, message: r.message }
        }
        default:
            return {
                success: false,
                message: `Unknown staking tx type: ${type}`,
            }
    }
}

function extractStakePayload(
    tx: Transaction,
): { amount: string; connectionUrl: string } | null {
    const data = tx.content?.data as unknown as [string, unknown] | undefined
    if (!Array.isArray(data) || data.length < 2) return null
    const p = data[1] as { amount?: unknown; connectionUrl?: unknown } | null
    if (!p || typeof p.amount !== "string") return null
    return {
        amount: p.amount,
        connectionUrl:
            typeof p.connectionUrl === "string" ? p.connectionUrl : "",
    }
}

