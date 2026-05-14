import Chain from "src/libs/blockchain/chain"
import { confirmTransaction } from "src/libs/blockchain/routines/validateTransaction"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { ValidityData, GCREdit, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"

export async function handleValidateTransaction(
    tx: Transaction,
    sender: string,
): Promise<ValidityData> {
    log.info("SERVER", "[handleTransactions] Handling a DEMOS tx...")
    const fname = "[handleTransactions] "
    log.info("SERVER", fname + "Handling transaction...")
    let validationData: ValidityData
    try {
        const handleConfirmTransactionStart = Date.now()
        validationData = await confirmTransaction(tx, sender)
        const handleConfirmTransactionEnd = Date.now()
        log.only(
            `[handleValidateTransaction] Transaction confirmed in ${handleConfirmTransactionEnd - handleConfirmTransactionStart}ms`,
        )

        const handleGcrEditsStart = Date.now()
        const gcrEdits = await GCRGeneration.generate(tx)
        const handleGcrEditsEnd = Date.now()
        log.only(
            `[handleValidateTransaction] GCR edits generated in ${handleGcrEditsEnd - handleGcrEditsStart}ms`,
        )
        gcrEdits.forEach((gcredit: GCREdit) => {
            gcredit.txhash = ""
        })
        const handleGcrEditsHashStart = Date.now()
        const gcrEditsHash = Hashing.sha256(JSON.stringify(gcrEdits))
        const handleGcrEditsHashEnd = Date.now()
        log.only(
            `[handleValidateTransaction] GCR edits hash generated in ${handleGcrEditsHashEnd - handleGcrEditsHashStart}ms`,
        )
        log.debug(
            "[handleValidateTransaction] gcrEditsHash: " + gcrEditsHash,
        )
        const txGcrEditsHash = Hashing.sha256(
            JSON.stringify(tx.content.gcr_edits),
        )
        log.debug(
            "[handleValidateTransaction] txGcrEditsHash: " + txGcrEditsHash,
        )
        const comparison = txGcrEditsHash === gcrEditsHash
        if (!comparison) {
            log.error(
                "[handleValidateTransaction] GCREdit mismatch: " +
                txGcrEditsHash +
                " <> " +
                gcrEditsHash,
            )
        }
        if (comparison) {
            log.info("[handleValidateTransaction] GCREdit hash match")
        } else {
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
                (sum: bigint, edit: GCREdit) => sum + BigInt((edit as any).amount),
                0n,
            )

        if (totalFee > 0n) {
            const checkFeeStart = Date.now()
            const db = await Datasource.getInstance()
            const gcrMainRepo = db
                .getDataSource()
                .getRepository(GCRMain)
            const account = await gcrMainRepo.findOneBy({
                pubkey: sender,
            })
            const senderBalance = account
                ? BigInt(account.balance)
                : 0n
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

    log.info("SERVER", fname + "Transaction handled.")
    return validationData
}
