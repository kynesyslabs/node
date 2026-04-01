import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import HandleGCR, { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import log from "src/utilities/logger"

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

        return { success: true, message: "Nonce applied", entity: accountGCR }
    }

    /**
     * Applies a nonce edit directly to an entity without database operations.
     * Used for batch processing where DB operations are deferred.
     *
     * @param editOperation The GCR edit to apply
     * @param entity The GCRMain entity to modify (mutated in place)
     * @returns Result indicating success/failure
     */
    static applyToEntity(
        editOperation: GCREdit,
        entity: GCRMain,
    ): { success: boolean; message: string } {
        if (editOperation.type !== "nonce") {
            return { success: false, message: "Invalid GCREdit type" }
        }

        // Determine operation (handle rollback)
        let operation = editOperation.operation
        if (editOperation.isRollback) {
            operation = operation === "add" ? "remove" : "add"
        }

        const actualNonce = entity.nonce

        if (operation === "add") {
            entity.nonce += editOperation.amount
        } else if (operation === "remove") {
            // Safeguarding the operation
            if (actualNonce < editOperation.amount) {
                return { success: false, message: "Insufficient nonce" }
            }
            entity.nonce -= editOperation.amount
        }

        return { success: true, message: "Nonce applied" }
    }
}
