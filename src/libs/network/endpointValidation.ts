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

export async function handleValidateTransaction(
    tx: Transaction,
    sender: string,
): Promise<ValidityData> {
    log.info("SERVER", "[handleTransactions] Handling a DEMOS tx...")
    const fname = "[handleTransactions] "
    log.info("SERVER", fname + "Handling transaction...")
    let validationData: ValidityData
    try {
        validationData = await confirmTransaction(tx, sender)

        const gcrEdits = await GCRGeneration.generate(tx)
        const generatedComparableEdits = gcrEdits as any[]
        const generatedNonTokenEdits = generatedComparableEdits.filter(
            (gcrEdit: any) => gcrEdit?.type !== "token",
        )
        generatedNonTokenEdits.forEach((gcrEdit: any) => {
            gcrEdit.txhash = ""
        })
        const gcrEditsHash = Hashing.sha256(
            JSON.stringify(generatedNonTokenEdits),
        )
        log.debug(
            "[handleValidateTransaction] gcrEditsHash: " + gcrEditsHash,
        )
        const txEdits = Array.isArray(tx.content.gcr_edits)
            ? (tx.content.gcr_edits as any[])
            : []
        const txNonTokenEdits = txEdits.filter(edit => edit?.type !== "token")
        const tokenEditsCount = txEdits.length - txNonTokenEdits.length
        const txGcrEditsHash = Hashing.sha256(JSON.stringify(txNonTokenEdits))
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
            log.info(
                `[handleValidateTransaction] GCREdit hash match (non-token edits; tokenEdits=${tokenEditsCount})`,
            )
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
        const signature = await ucrypto.sign(
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
