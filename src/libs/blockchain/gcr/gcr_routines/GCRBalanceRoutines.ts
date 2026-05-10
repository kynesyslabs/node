import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import HandleGCR, { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { getSharedState } from "@/utilities/sharedState"
import log from "src/utilities/logger"

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
