import {GCREdit} from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCR_Main } from "src/model/entities/GCRv2/GCR_Main"

export default class GCRBalanceRoutines {
    static async apply(editOperation: GCREdit, GCRMainRepository: Repository<GCR_Main>): Promise<[boolean, string]> {
        if (editOperation.type !== "balance") {
            return [false, "Invalid GCREdit type"]
        }
        console.log(
            "Applying GCREdit balance: ",
            editOperation.operation,
            editOperation.amount,
            editOperation.account,
        )
        // Getting the account GCR
        var accountGCR = await GCRMainRepository.findOneBy({
            pubkey: editOperation.account,
        })
        if (!accountGCR) {
            return [false, "Account not found"] // REVIEW Or create it?
        }
        // Getting the actual balance to apply the operation
        var actualBalance = accountGCR.balance
        if (editOperation.operation === "add") {
            accountGCR.balance += editOperation.amount
        } else if (editOperation.operation === "remove") {
            // Safeguarding the operation
            if (actualBalance < editOperation.amount) {
                return [false, "Insufficient balance"]
            }
            accountGCR.balance -= editOperation.amount
        }
        // Saving the account GCR
        await GCRMainRepository.save(accountGCR)
        return [true, "Balance applied"]
    }
}
