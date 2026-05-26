import Chain from "src/libs/blockchain/chain"
import { confirmTransaction } from "src/libs/blockchain/routines/validateTransaction"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import {
    ValidityData,
    GCREdit,
    SigningAlgorithm,
} from "@kynesyslabs/demosdk/types"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import { denomination } from "@kynesyslabs/demosdk"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { isForkActive } from "@/forks/forkGates"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"
import GCR from "../blockchain/gcr/gcr"

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

        // Normalise the regenerated gcrEdits through the SAME serializer
        // the SDK ran on its side before broadcast. Without this, the
        // post-fork SDK ships `gcr_edits[i].amount` as a canonical OS
        // decimal string (e.g. `"1000000000"` for the 1-DEM gas edit)
        // while `GCRGeneration.generate` returns the raw author shape
        // (`amount: 1` as a JS `number` in DEM for the gas edit). Hashing
        // those two shapes diverges, surfacing here as a spurious
        // `GCREdit mismatch` even though the edit set is otherwise
        // identical (subtract + add + gas + nonce, same accounts, same
        // base amount).
        //
        // We piggyback on `serializeTransactionContent` (SDK), which is
        // the canonical wire-shape transform — it already walks
        // `gcr_edits[]` and rewrites embedded `amount` fields on
        // `balance` / `escrow` / `validatorStake` entries per
        // `transformEditPostFork` (or `…PreFork` when the fork is
        // inactive). Wrapping the regenerated edits into a throwaway
        // content envelope is the cheapest way to reuse that walker
        // without exporting the private helper.
        //
        // Block-height source: `Chain.getLastBlockNumber()` mirrors what
        // the SDK uses on the client side (its `_isPostForkCached`
        // ultimately resolves against the same gate via the
        // `getNetworkInfo` RPC). Pending-tx hashing always references the
        // current chain tip — block-0 / mempool entries are caught by
        // `isForkActive` returning `false` on a null/future activation.
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
        // SYMMETRY: tx.content.gcr_edits must be hashed in the EXACT same
        // shape as `normalisedRegen` above, otherwise any field the SDK
        // populates that the regen path blanks (or vice-versa) shows up as
        // a spurious "GCREdit mismatch". Two specific gotchas:
        //   1. `txhash`. The SDK currently ships gcr_edits with `txhash`
        //      empty, but some flows (and older nodes) propagate the
        //      parent tx hash into every edit. Force-blank on both sides
        //      to make the hash invariant under that choice.
        //   2. Embedded amount shape (number vs OS string). Already
        //      handled by `normaliseGcrEditsForHash`; we mirror that
        //      walker on the tx-side input by feeding it through the
        //      same envelope.
        const txEditsBlanked = (tx.content.gcr_edits ?? []).map(
            (e: GCREdit) => ({ ...e, txhash: "" }),
        )
        const normalisedTxEdits = normaliseGcrEditsForHash(txEditsBlanked)
        const txGcrEditsHash = Hashing.sha256(
            JSON.stringify(normalisedTxEdits),
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

    log.info("SERVER", fname + "Transaction handled.")
    return validationData
}
