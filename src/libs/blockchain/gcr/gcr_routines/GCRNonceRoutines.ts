import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import HandleGCR, { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import log from "src/utilities/logger"
import { isForkActive } from "@/forks"
import { getSharedState } from "@/utilities/sharedState"

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

        // Audit-sweep batch C PR 3 — cross-RPC replay safety net.
        //
        // Fork-gated on `nonceEnforcement`. Pre-fork: ignore the
        // field entirely so a client shipping `expectedPrior` on a
        // pre-fork node cannot induce rejections that newer-binary
        // nodes would also enforce (consensus split risk before
        // activation). Hash-strip in `endpointValidation` means
        // `expectedPrior` is not signed, so pre-fork clients could
        // attach it without breaking signature validation — that is
        // exactly the validator-split footgun this gate avoids
        // (PR #886 review: CodeRabbit Critical).
        //
        // Post-fork: when `expectedPrior` is present on the edit,
        // reject the application if the on-chain account nonce does
        // not match. This catches the case where two competing
        // same-nonce txs from different RPCs both pass per-node
        // validation but get bundled into the same block: the first
        // applies, the second sees `accountGCR.nonce !==
        // expectedPrior` and is rejected.
        //
        // `expectedPrior` is populated at validation time by
        // `assignNonce` (see `validateTransaction.ts`) from
        // `account.nonce + pendingMempoolCount`. The field is stripped
        // from both incoming and SDK-regen edits in
        // `endpointValidation` before the hash comparison, so the
        // signature contract is unaffected.
        //
        // Rollback path: skip the check. Rollbacks unwind a prior
        // apply; the recorded `expectedPrior` is the value BEFORE the
        // original apply, not after. Re-checking would always fail
        // because `accountGCR.nonce` has already advanced.
        //
        // Block-height source for the fork gate: prefer
        // `accountGCR.blockNumber` when set by the apply pipeline;
        // fall back to `getSharedState.lastBlockNumber`. Apply paths
        // run inside block processing so the shared-state tip is
        // accurate.
        // if (
        //     !editOperation.isRollback &&
        //     typeof editOperation.expectedPrior === "number"
        // ) {
        //     const blockHeight = getSharedState.lastBlockNumber ?? 0
        //     if (isForkActive("nonceEnforcement", blockHeight)) {
        //         if (actualNonce !== editOperation.expectedPrior) {
        //             log.error(
        //                 `[GCRNonceRoutines] expectedPrior mismatch for ${editOperationAccount}: ` +
        //                     `accountGCR.nonce=${actualNonce}, expectedPrior=${editOperation.expectedPrior} — ` +
        //                     "rejecting nonce edit (cross-RPC replay or out-of-order apply)",
        //             )
        //             return {
        //                 success: false,
        //                 message:
        //                     `Nonce expectedPrior mismatch: account.nonce=${actualNonce}, ` +
        //                     `expectedPrior=${editOperation.expectedPrior}`,
        //             }
        //         }
        //     }
        // }

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
}
