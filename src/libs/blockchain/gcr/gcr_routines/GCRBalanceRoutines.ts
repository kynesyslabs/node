import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCR_Main } from "src/model/entities/GCRv2/GCR_Main"
import HandleGCR, { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import { ForgeToHex } from "@/libs/crypto/forgeUtils"

export default class GCRBalanceRoutines {
    static async apply(
        editOperation: GCREdit,
        GCRMainRepository: Repository<GCR_Main>,
        simulate: boolean,
    ): Promise<GCRResult> {
        if (editOperation.type !== "balance") {
            return { success: false, message: "Invalid GCREdit type" }
        }

        let editOperationAccount =
            typeof editOperation.account !== "string"
                ? ForgeToHex(editOperation.account)
                : editOperation.account

        console.log(
            "Applying GCREdit balance: ",
            editOperation.operation,
            editOperation.amount,
            editOperationAccount,
            editOperation.isRollback ? "ROLLBACK" : "NORMAL",
        )
        // Reversing the operation if it is a rollback
        if (editOperation.isRollback) {
            editOperation.operation =
                editOperation.operation === "add" ? "remove" : "add"
        }

        // Getting the account GCR
        var accountGCR = await GCRMainRepository.findOneBy({
            pubkey: editOperationAccount,
        })

        if (!accountGCR) {
            accountGCR = await HandleGCR.createAccount(editOperationAccount)
        }

        console.error("accountGCR: " + JSON.stringify(accountGCR, null, 2))

        // Getting the actual balance to apply the operation
        var actualBalance = accountGCR.balance

        if (editOperation.operation === "add") {
            accountGCR.balance =
                parseInt(accountGCR.balance as unknown as string) +
                editOperation.amount
        } else if (editOperation.operation === "remove") {
            // Safeguarding the operation
            if (actualBalance < editOperation.amount) {
                return { success: false, message: "Insufficient balance" }
            }
            accountGCR.balance =
                parseInt(accountGCR.balance as unknown as string) -
                editOperation.amount
        }

        // Saving the account GCR if not simulating
        if (!simulate) {
            await GCRMainRepository.save(accountGCR)
        }

        return { success: true, message: "Balance applied" }
    }
}
