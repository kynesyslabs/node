import log from "src/utilities/logger"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import type { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import {
    isL2PSNonceEdit,
    l2psNonceOf,
    withL2PSNonce,
    type GCREditL2PSNonce,
} from "@/libs/l2ps/settlement/l2psNonce"

/**
 * Moves an account's L2PS nonce in one subnet. Only a settlement batch
 * derives this edit; block apply refuses a transaction that ships one.
 */
export default class GCRL2PSNonceRoutines {
    static async apply(edit: GCREditL2PSNonce, account: GCRMain | null): Promise<GCRResult> {
        if (!isL2PSNonceEdit(edit)) {
            return { success: false, message: "Invalid GCREdit type" }
        }
        if (!account) {
            return { success: false, message: "Missing account for l2psNonce edit" }
        }
        if (
            typeof edit.l2psUid !== "string" ||
            edit.l2psUid.length === 0 ||
            !Number.isSafeInteger(edit.amount) ||
            edit.amount < 0
        ) {
            return { success: false, message: "Malformed l2psNonce edit" }
        }

        // A rollback reverses the operation, on a copy: the edit belongs to
        // the transaction and is applied again if the block is re-run.
        const operation = edit.isRollback
            ? edit.operation === "add"
                ? "remove"
                : "add"
            : edit.operation

        const current = l2psNonceOf(account, edit.l2psUid)
        let next: number
        if (operation === "add") {
            next = current + edit.amount
            if (!Number.isSafeInteger(next)) {
                return { success: false, message: "L2PS nonce overflow" }
            }
        } else if (operation === "remove") {
            if (current < edit.amount) {
                return { success: false, message: "Insufficient L2PS nonce" }
            }
            next = current - edit.amount
        } else {
            return { success: false, message: "Invalid l2psNonce operation" }
        }

        log.debug(
            `Applying GCREdit l2psNonce: ${edit.account} ${edit.l2psUid} ${operation} ${edit.amount}` +
                (edit.isRollback ? " ROLLBACK" : ""),
        )
        account.l2psNonces = withL2PSNonce(account.l2psNonces, edit.l2psUid, next)
        return { success: true, message: "L2PS nonce applied", entity: account }
    }
}
