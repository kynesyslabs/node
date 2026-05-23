import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import HandleGCR, { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { getSharedState } from "@/utilities/sharedState"
import log from "src/utilities/logger"
import { isForkActive } from "@/forks"

export default class GCRBalanceRoutines {
    static async apply(
        editOperation: GCREdit,
        accountGCR: GCRMain,
        // gcrMainRepository: Repository<GCRMain>,
        // simulate: boolean,
    ): Promise<GCRResult> {
        if (editOperation.type !== "balance") {
            return { success: false, message: "Invalid GCREdit type" }
        }

        const editOperationAccount =
            typeof editOperation.account !== "string"
                ? forgeToHex(editOperation.account)
                : editOperation.account

        // REVIEW Coerce editOperation.amount to BigInt once at the routine
        // boundary. Today the SDK types it as `number`, but consensus-critical
        // code must not silently round on amounts > 2^53, and once the SDK
        // moves to OS-string the comparisons below (`actualBalance < editAmount`)
        // would otherwise silently degrade to string-vs-bigint comparisons
        // that compile but produce wrong runtime behavior. The cast keeps the
        // boundary loose so future SDK versions can widen `amount` to
        // bigint/string without churn here.
        let editAmount: bigint
        try {
            editAmount = BigInt(
                editOperation.amount as bigint | number | string,
            )
        } catch {
            return { success: false, message: "Invalid amount" }
        }

        // Safeguarding the operation by checking if the amount is positive
        if (editAmount <= 0n) {
            return { success: false, message: "Invalid amount" }
        }

        log.debug(
            "Applying GCREdit balance: " +
                editOperation.operation +
                " " +
                editAmount +
                " " +
                editOperationAccount +
                " " +
                (editOperation.isRollback ? "ROLLBACK" : "NORMAL"),
        )
        // Reversing the operation if it is a rollback
        if (editOperation.isRollback) {
            editOperation.operation =
                editOperation.operation === "add" ? "remove" : "add"
        }

        // DEM-665 — burn-address spend prevention.
        //
        // Post-fork the burn account at `feeDistribution.burnAddress`
        // is consensus-significant: balances added to it represent
        // permanently removed supply. A normal `remove` against this
        // pubkey would re-circulate burned coins — refuse it.
        //
        // Two intentional carve-outs:
        //   1. The check fires AFTER the rollback inversion above, so a
        //      rollback of a prior burn `add` (which becomes a `remove`
        //      via inversion + isRollback=true) IS allowed. Otherwise
        //      fee distribution would be irreversible.
        //   2. The check is gated on isForkActive — pre-fork the burn
        //      address isn't yet a designated consensus account, so
        //      legacy code paths that happen to mention it stay intact.
        //
        // Address comparison is case-normalised (lowercase) to match
        // the PR #778 G-1/G-4 lesson (myc#6).
        if (
            editOperation.operation === "remove" &&
            !editOperation.isRollback
        ) {
            const blockHeight = getSharedState.lastBlockNumber ?? 0
            const fd = getSharedState.feeDistribution
            if (
                fd &&
                isForkActive("gasFeeSeparation", blockHeight) &&
                editOperationAccount.toLowerCase() ===
                    fd.burnAddress.toLowerCase()
            ) {
                return {
                    success: false,
                    message: "Cannot deduct from burn address",
                }
            }
        }

        // Getting the account GCR
        // let accountGCR = await gcrMainRepository.findOneBy({
        //     pubkey: editOperationAccount,
        // })

        // if (!accountGCR) {
        //     accountGCR = await HandleGCR.createAccount(editOperationAccount)
        // }

        // Getting the actual balance to apply the operation.
        // REVIEW TypeORM returns bigint columns as JS strings on some drivers,
        // so coerce to bigint to make the comparison below safe.
        const actualBalance = BigInt(accountGCR.balance)

        if (editOperation.operation === "add") {
            accountGCR.balance = actualBalance + editAmount
        } else if (editOperation.operation === "remove") {
            // Safeguarding the operation
            // NOTE PROD flag is used to enable testing when not in production
            if (
                (actualBalance < editAmount || actualBalance === 0n) &&
                getSharedState.PROD
            ) {
                return { success: false, message: "Insufficient balance" }
            }
            accountGCR.balance = actualBalance - editAmount

            // Safeguarding the operation by checking if the balance is negative
            // NOTE This applies just to the non-production environment
            if (accountGCR.balance < 0n && !getSharedState.PROD) {
                accountGCR.balance = 0n
            }
        }

        // Saving the account GCR if not simulating
        // if (!simulate) {
        //     try {
        //         await gcrMainRepository.save(accountGCR)
        //     } catch (error) {
        //         return { success: false, message: "Failed to save account GCR" }
        //     }
        // }

        return { success: true, message: "Balance applied", entity: accountGCR }
    }
}
