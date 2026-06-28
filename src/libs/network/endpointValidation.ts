import { denomination } from "@kynesyslabs/demosdk"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { ValidityData, GCREdit } from "@kynesyslabs/demosdk/types"

import log from "src/utilities/logger"
import GCR from "../blockchain/gcr/gcr"
import Hashing from "src/libs/crypto/hashing"
import Chain from "src/libs/blockchain/chain"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "src/utilities/sharedState"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"
import { confirmTransaction } from "src/libs/blockchain/routines/validateTransaction"

export async function handleValidateTransaction(
    tx: Transaction,
    sender: string,
): Promise<ValidityData> {
    let validationData: ValidityData
    try {
        const txShippedGcrEdits: GCREdit[] = JSON.parse(
            JSON.stringify(tx.content.gcr_edits ?? []),
        )

        const handleConfirmTransactionStart = Date.now()
        validationData = await confirmTransaction(tx, sender)
        const handleConfirmTransactionEnd = Date.now()
        log.only(
            `[handleValidateTransaction] Transaction confirmed in ${handleConfirmTransactionEnd - handleConfirmTransactionStart}ms`,
        )

        const handleGcrEditsStart = Date.now()
        const gcrEdits = await GCRGeneration.generate(tx)
        gcrEdits.forEach((edit: GCREdit) => {
            edit.txhash = ""
        })
        const handleGcrEditsEnd = Date.now()

        log.only(
            `[handleValidateTransaction] GCR edits generated in ${handleGcrEditsEnd - handleGcrEditsStart}ms`,
        )

        const blockHeight = await Chain.getLastBlockNumber()
        const postFork = isForkActive("osDenomination", blockHeight)

        const normaliseGcrEditsForHash = (edits: GCREdit[]): GCREdit[] => {
            // Build a minimal `TransactionContent`-shaped envelope so
            // `serializeTransactionContent` can do its `gcr_edits[]`
            // walk; the other fields are passed through unchanged.
            const envelope = {
                ...tx.content,
                gcr_edits: edits,
            }
            const serialised = denomination.serializeTransactionContent(
                envelope as any,
                postFork,
            )
            const parsed = JSON.parse(serialised) as { gcr_edits: GCREdit[] }
            return parsed.gcr_edits ?? []
        }

        const handleGcrEditsHashStart = Date.now()
        const normalisedRegen = normaliseGcrEditsForHash(gcrEdits)
        const gcrEditsHash = Hashing.sha256(JSON.stringify(normalisedRegen))
        const handleGcrEditsHashEnd = Date.now()
        log.only(
            `[handleValidateTransaction] GCR edits hash generated in ${handleGcrEditsHashEnd - handleGcrEditsHashStart}ms`,
        )
        log.debug("[handleValidateTransaction] gcrEditsHash: " + gcrEditsHash)
        const txEditsBlanked = txShippedGcrEdits.map((e: GCREdit) => ({
            ...e,
            txhash: "",
        }))
        const normalisedTxEdits = normaliseGcrEditsForHash(txEditsBlanked)
        const txGcrEditsHash = Hashing.sha256(JSON.stringify(normalisedTxEdits))
        log.debug(
            "[handleValidateTransaction] txGcrEditsHash: " + txGcrEditsHash,
        )
        log.debug("[handleValidateTransaction] SYMMETRIC-NORMALISE-V2 active")
        const checksOut = txGcrEditsHash === gcrEditsHash

        if (!checksOut) {
            try {
                log.error(
                    "[handleValidateTransaction] Incoming tx hash: " + tx.hash,
                )
                log.error(
                    "[handleValidateTransaction] Incoming tx edits (normalized): " +
                        JSON.stringify(normalisedTxEdits, null, 2),
                )

                log.error(
                    "[handleValidateTransaction] RPC-generated tx hash: " +
                        gcrEditsHash,
                )
                log.error(
                    "[handleValidateTransaction] RPC-generated tx edits: " +
                        JSON.stringify(normalisedRegen, null, 2),
                )
                log.error(
                    "[handleValidateTransaction] Incoming tx edits (raw): " +
                        JSON.stringify(tx.content.gcr_edits ?? []),
                )
            } catch (dumpErr) {
                log.error(
                    "[handleValidateTransaction] mismatch dump failed: " +
                        (dumpErr instanceof Error
                            ? dumpErr.message
                            : String(dumpErr)),
                )
            }

            log.error(
                "[handleValidateTransaction] GCREdit mismatch: " +
                    txGcrEditsHash +
                    " <> " +
                    gcrEditsHash,
            )
            throw new Error("GCREdit mismatch")
        }

        const totalFee = gcrEdits
            .filter(
                (edit: GCREdit) =>
                    edit.type === "balance" &&
                    edit.operation === "remove" &&
                    (edit.account === sender ||
                        (typeof edit.account !== "string" &&
                            (edit.account as any)?.toString() === sender)),
            )
            .reduce(
                (sum: bigint, edit: GCREdit) =>
                    sum + BigInt((edit as any).amount),
                0n,
            )

        if (totalFee > 0n) {
            const checkFeeStart = Date.now()
            const senderBalance = await GCR.getAccountBalance(sender)
            const checkFeeEnd = Date.now()
            log.only(
                `[handleValidateTransaction] Check fee in ${checkFeeEnd - checkFeeStart}ms`,
            )
            if (senderBalance < totalFee) {
                throw new Error(
                    `Insufficient balance: required ${totalFee.toString()}, available ${senderBalance.toString()}`,
                )
            }
        }
    } catch (e) {
        log.error("SERVER", "[TX VALIDATION ERROR] 💀 : " + e)
        validationData = {
            data: {
                valid: false,
                reference_block: null,
                message:
                    e instanceof Error
                        ? e.message
                        : "An error occurred while validating the transaction",
                gas_operation: null,
                transaction: null,
            },
            signature: null,
            rpc_public_key: null,
        }
        const hashedValidationData = Hashing.sha256(
            JSON.stringify(validationData.data),
        )
        const signature = await TxValidatorPool.getInstance().sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(hashedValidationData),
        )

        validationData.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }
    }

    return validationData
}
