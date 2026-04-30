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

        // Safeguarding the operation by checking if the amount is positive
        if (editOperation.amount <= 0) {
            return { success: false, message: "Invalid amount" }
        }

        log.debug(
            "Applying GCREdit balance: " +
                editOperation.operation +
                " " +
                editOperation.amount +
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

        // Getting the actual balance to apply the operation
        const actualBalance = accountGCR.balance

        if (editOperation.operation === "add") {
            accountGCR.balance =
                BigInt(accountGCR.balance) + BigInt(editOperation.amount)
        } else if (editOperation.operation === "remove") {
            // Safeguarding the operation
            // NOTE PROD flag is used to enable testing when not in production
            if (
                (actualBalance < editOperation.amount ||
                    actualBalance === 0n) &&
                getSharedState.PROD
            ) {
                return { success: false, message: "Insufficient balance" }
            }
            accountGCR.balance =
                BigInt(accountGCR.balance) - BigInt(editOperation.amount)

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
