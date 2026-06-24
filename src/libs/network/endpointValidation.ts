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
    const fname = "[handleTransactions] "

    let validationData: ValidityData
    try {
        // SNAPSHOT the SDK-shipped gcr_edits BEFORE confirmTransaction
        // mutates the array. `confirmTransaction` calls
        // `applyGasFeeSeparation` when the gasFeeSeparation fork is
        // active, which PREPENDS node-computed fee edits onto
        // `tx.content.gcr_edits`. Without this snapshot, the hash
        // comparison below would be comparing
        //   tx.content.gcr_edits (mutated: [fee...,subtract,add,gas,nonce])
        // against
        //   GCRGeneration.generate(tx) (regen: [subtract,add,gas,nonce])
        // and diverge by exactly the prepended fee edits — a structural
        // mismatch the SDK has no way to predict because the fee
        // distribution is the validator's computation, not the
        // signer's. Hashing the snapshot keeps the compare meaningful:
        // "did the SDK ship the same edits GCRGeneration would
        // regenerate?", which is the actual invariant we want.
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
        const handleGcrEditsEnd = Date.now()

        // check nonce from db
        const nonce = await GCR.getAccountNonce(tx.content.from_ed25519_address)
        log.debug("================================================")
        log.debug("Tx hash: " + tx.hash)
        log.debug("Account nonce on RPC: " + nonce)
        log.debug("================================================")

        log.only(
            `[handleValidateTransaction] GCR edits generated in ${handleGcrEditsEnd - handleGcrEditsStart}ms`,
        )
        gcrEdits.forEach((gcredit: GCREdit) => {
            gcredit.txhash = ""
            // Audit-sweep batch C PR 3 — strip the node-only
            // `expectedPrior` field from the regen side before
            // hashing. The SDK never populates it; the node fills it
            // in at validation time inside `assignNonce` (see
            // `validateTransaction.ts`) from
            // `account.nonce + pendingMempoolCount`. Leaving it on
            // the regen side would diverge from the SDK-shipped edit
            // and surface as a spurious GCREdit mismatch.
            if (gcredit.type === "nonce" && "expectedPrior" in gcredit) {
                delete (gcredit as { expectedPrior?: number }).expectedPrior
            }
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
        // Use the PRE-confirmTransaction snapshot, not tx.content.gcr_edits,
        // which `applyGasFeeSeparation` may have mutated by prepending
        // node-computed fee edits.
        const txEditsBlanked = txShippedGcrEdits.map((e: GCREdit) => {
            const blanked = { ...e, txhash: "" }
            // Audit-sweep batch C PR 3 — symmetric strip of
            // `expectedPrior` on the tx-side input. The SDK 4.0.5+
            // type allows the field but the SDK runtime never writes
            // it; an old or non-conformant client could nonetheless
            // ship it. Drop it here so the hash is invariant under
            // that choice, matching the regen-side strip above.
            if (blanked.type === "nonce" && "expectedPrior" in blanked) {
                delete (blanked as { expectedPrior?: number }).expectedPrior
            }
            return blanked
        })
        const normalisedTxEdits = normaliseGcrEditsForHash(txEditsBlanked)
        const txGcrEditsHash = Hashing.sha256(
            JSON.stringify(normalisedTxEdits),
        )
        log.debug(
            "[handleValidateTransaction] txGcrEditsHash: " + txGcrEditsHash,
        )
        // CANARY: distinctive log line that proves the running binary
        // includes the symmetric-normalisation branch (PR #867+). If you
        // grep node logs for this string and see nothing, the runtime is
        // executing pre-PR-#867 bytes despite the source file on disk
        // appearing up-to-date.
        log.debug(
            "[handleValidateTransaction] SYMMETRIC-NORMALISE-V2 active",
        )
        const comparison = txGcrEditsHash === gcrEditsHash
        if (!comparison) {
            // DEBUG: on mismatch, dump the raw JSON shape both sides see
            // so we can identify the specific field that diverges between
            // SDK ship and node regen. Hex-encoded so multi-line JSON
            // doesn't break log parsing.
            try {
                log.error(
                    "[handleValidateTransaction] mismatch dump.tx: " +
                        JSON.stringify(normalisedTxEdits),
                )
                log.error(
                    "[handleValidateTransaction] mismatch dump.regen: " +
                        JSON.stringify(normalisedRegen),
                )
                log.error(
                    "[handleValidateTransaction] mismatch dump.rawTx: " +
                        JSON.stringify(tx.content.gcr_edits ?? []),
                )
            } catch (dumpErr) {
                log.error(
                    "[handleValidateTransaction] mismatch dump failed: " +
                        (dumpErr instanceof Error ? dumpErr.message : String(dumpErr)),
                )
            }
            log.error(
                "[handleValidateTransaction] GCREdit mismatch: " +
                    txGcrEditsHash +
                    " <> " +
                    gcrEditsHash,
            )
        }
        if (!comparison) {
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
