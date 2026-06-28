import log from "src/utilities/logger"
import { GCREdit } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "src/libs/blockchain/gcr/handleGCR"

export default class GCRNonceRoutines {
    static async apply(
        editOperation: GCREdit,
        accountGCR: GCRMain,
    ): Promise<GCRResult> {
        if (editOperation.type !== "nonce") {
            return { success: false, message: "Invalid GCREdit type" }
        }

        const editOperationAccount =
            typeof editOperation.account !== "string"
                ? forgeToHex(editOperation.account)
                : editOperation.account

        log.debug(
            "Applying GCREdit nonce: " +
                editOperationAccount +
                " " +
                editOperation.operation +
                " " +
                editOperation.amount +
                " " +
                (editOperation.isRollback ? "ROLLBACK" : "NORMAL"),
        )

        // Reversing the operation if it is a rollback
        if (editOperation.isRollback) {
            editOperation.operation =
                editOperation.operation === "add" ? "remove" : "add"
        }

        if (editOperation.operation === "add") {
            accountGCR.nonce += editOperation.amount
        } else if (editOperation.operation === "remove") {
            // Safeguarding the operation
            if (accountGCR.nonce < editOperation.amount) {
                return { success: false, message: "Insufficient nonce" }
            }
            accountGCR.nonce -= editOperation.amount
        }

        return { success: true, message: "Nonce applied", entity: accountGCR }
    }
}
