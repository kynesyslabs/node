import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import HandleGCR, { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

export default class GCRNonceRoutines {
    static async apply(
        editOperation: GCREdit,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        if (editOperation.type !== "nonce") {
            return { success: false, message: "Invalid GCREdit type" }
        }

        const editOperationAccount =
            typeof editOperation.account !== "string"
                ? forgeToHex(editOperation.account)
                : editOperation.account

        console.log(
            "Applying GCREdit nonce: ",
            editOperationAccount,
            editOperation.operation,
            editOperation.amount,
            editOperation.isRollback ? "ROLLBACK" : "NORMAL",
        )
        // Reversing the operation if it is a rollback
        if (editOperation.isRollback) {
            editOperation.operation =
                editOperation.operation === "add" ? "remove" : "add"
        }
        // Getting the account GCR
        let accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperationAccount,
        })

        if (!accountGCR) {
            accountGCR = await HandleGCR.createAccount(editOperationAccount)
        }

        // Getting the actual nonce to apply the operation
        const actualNonce = accountGCR.nonce

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
        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }
        return { success: true, message: "Nonce applied" }
    }
}
