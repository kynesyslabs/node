import type { Transaction } from "@kynesyslabs/demosdk/types"
import ValidatorsManagement from "@/libs/blockchain/routines/validatorsManagement"
import type { GCREditValidatorStake } from "@/features/staking/types"
import log from "src/utilities/logger"

interface StakingTxResult {
    success: boolean
    message: string
}

/**
 * Handles validatorStake / validatorUnstake / validatorExit transactions.
 *
 * Performs policy-level validation and synthesizes the GCREditValidatorStake
 * edit that HandleGCR will apply at block confirmation.
 *
 * **Why we synthesize the edit here**: SDK Batch 1 has not yet shipped, so
 * clients cannot build a `GCREditValidatorStake` themselves. Until it does,
 * the node derives the edit from the tx payload+sender. When the SDK starts
 * emitting client-built edits, this module should prefer the client-supplied
 * edit and fall back to synthesis only if absent — or assert the two match.
 */
export async function handleStakingTx(
    tx: Transaction,
): Promise<StakingTxResult> {
    const type = tx.content.type as string
    const sender = requireSender(tx)
    if (!sender) {
        return { success: false, message: "Missing sender" }
    }

    switch (type) {
        case "validatorStake": {
            const r = await ValidatorsManagement.manageValidatorStakeTx(
                tx as unknown as Parameters<
                    typeof ValidatorsManagement.manageValidatorStakeTx
                >[0],
            )
            log.debug(
                `[handleStakingTx] validatorStake ${tx.hash ?? ""} → ${r.valid}: ${r.message}`,
            )
            if (!r.valid) return { success: false, message: r.message }

            const payload = extractStakePayload(tx)
            if (!payload) {
                return { success: false, message: "Missing stake payload" }
            }
            attachEdit(
                tx,
                ValidatorsManagement.buildStakeEdit(
                    sender,
                    payload.amount,
                    payload.connectionUrl,
                    tx.hash ?? "",
                ),
            )
            return { success: true, message: r.message }
        }
        case "validatorUnstake": {
            const r = await ValidatorsManagement.manageValidatorUnstakeTx(
                tx as unknown as Parameters<
                    typeof ValidatorsManagement.manageValidatorUnstakeTx
                >[0],
            )
            if (!r.valid) return { success: false, message: r.message }
            attachEdit(
                tx,
                ValidatorsManagement.buildUnstakeEdit(sender, tx.hash ?? ""),
            )
            return { success: true, message: r.message }
        }
        case "validatorExit": {
            const r = await ValidatorsManagement.manageValidatorExitTx(
                tx as unknown as Parameters<
                    typeof ValidatorsManagement.manageValidatorExitTx
                >[0],
            )
            if (!r.valid) return { success: false, message: r.message }
            attachEdit(
                tx,
                ValidatorsManagement.buildExitEdit(sender, tx.hash ?? ""),
            )
            return { success: true, message: r.message }
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

function requireSender(tx: Transaction): string | null {
    const from = tx.content?.from
    if (typeof from === "string" && from.length > 0) return from
    const ed = tx.content?.from_ed25519_address
    if (typeof ed === "string" && ed.length > 0) return ed
    return null
}

function attachEdit(tx: Transaction, edit: GCREditValidatorStake): void {
    // Push onto the existing gcr_edits array (preserve any client-supplied
    // edits the SDK may already have put there once Batch 1 ships). Dedup on
    // (type, operation, account) so re-runs through the dispatcher are idempotent.
    const edits = (tx.content.gcr_edits ??
        []) as unknown as GCREditValidatorStake[]
    const duplicate = edits.some(
        e =>
            e?.type === "validatorStake" &&
            e?.operation === edit.operation &&
            e?.account === edit.account,
    )
    if (!duplicate) {
        edits.push(edit)
    }
    tx.content.gcr_edits = edits as unknown as typeof tx.content.gcr_edits
}
