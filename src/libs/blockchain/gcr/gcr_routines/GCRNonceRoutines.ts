import {GCREdit} from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCR_Main } from "src/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "src/libs/blockchain/gcr/handleGCR"

export default class GCRNonceRoutines {
    static async apply(editOperation: GCREdit, GCRMainRepository: Repository<GCR_Main>): Promise<GCRResult> {
        if (editOperation.type !== "nonce") {
            return { success: false, message: "Invalid GCREdit type" }
        }
        console.log("Applying GCREdit nonce: ", editOperation.account, editOperation.operation, editOperation.amount)
        // Getting the account GCR
        var accountGCR = await GCRMainRepository.findOneBy({
            pubkey: editOperation.account,
        })
        if (!accountGCR) {
            return { success: false, message: "Account not found" } // REVIEW Or create it?
        }
        // Getting the actual nonce to apply the operation
        var actualNonce = accountGCR.nonce
        if (editOperation.operation === "add") {
            accountGCR.nonce += editOperation.amount
        } else if (editOperation.operation === "remove") {
            // Safeguarding the operation
            if (actualNonce < editOperation.amount) {
                return { success: false, message: "Insufficient nonce" }
            }
            accountGCR.nonce -= editOperation.amount
        }
        // Saving the account GCR
        await GCRMainRepository.save(accountGCR)
        return { success: true, message: "Nonce applied" }
    }
}
