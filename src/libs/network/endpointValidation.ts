import { denomination } from "@kynesyslabs/demosdk"
import { generateGcrEdits } from "@/libs/blockchain/validation/generateGcrEdits"
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
import {
    editBindingState,
    verifyAdmissionEdits,
} from "src/libs/blockchain/validation/editBinding"
import { confirmTransaction } from "src/libs/blockchain/routines/validateTransaction"
import { L2PS_GATE_REFUSAL } from "@/forks/l2psGate"
import { TLSN_DISABLED_REFUSAL } from "@/forks/tlsnDisabledGate"
import { TOKEN_STAKING_REFUSAL } from "@/forks/tokenStakingGate"

// The admission refusals a client is told at confirm: each names a fixed rule
// or echoes only the client's own transaction. Any other reason, including
// one a later rule adds, is told as the bare mismatch and stays in the log.
// The entries and shapes below copy the refusal text in editBinding,
// nativeValueRules, feeBinding, txTypes and governanceGate: rewording a
// refusal there needs the same change here, or the client is told only
// "GCREdit mismatch".
const PUBLIC_ADMISSION_REASONS: ReadonlySet<string> = new Set([
    "an instantMessaging transaction without edits must be signed by a staked validator",
    "network governance is not active at this height",
    "sender address is not lowercase hex",
    "native send recipient is not a lowercase 0x-prefixed 32-byte hex address",
    "transaction_fee.rpc_address is not lowercase hex",
    "balance edit account is not lowercase hex",
    "native send args must be [to, amount]",
    "native send pays another recipient than content.to",
    "native send pays another amount than content.amount",
    "native transaction carries no transaction_fee",
    "transaction_fee names an rpc_address; the sender does not route the rpc share",
    "awardPoints: genesis names no award signer",
    "awardPoints: not signed by the genesis award signer",
    "awardPoints: data carries no account list",
    "awardPoints: data carries unexpected elements",
    "gcr_edits do not match regenerated set",
    "storageProgram edit names another sender than the signer",
    "nonce edit carries unexpected fields",
    "nonce edit is not +1 on the sender's account",
    "transaction nonce is not a positive integer",
])

// Their variable part is taken from the client's transaction.
const PUBLIC_ADMISSION_SHAPES: readonly RegExp[] = [
    /^transaction type .* is not accepted$/,
    /^\w+ edit carried by a .* transaction$/,
    /^\w+ edit acts on another account than the (sender|signer)$/,
    /^transaction_fee\.\w+ is not an amount( apply can charge)?: .*$/,
    /^awardPoints: \d+ edits for \d+ resolved accounts$/,
    /^awardPoints: invalid points for .*$/,
    /^awardPoints: edit \d+ (carries unexpected fields|is not the credit its data implies|does not name the bucket its data names|has an invalid or inconsistent date)$/,
    /^awardPoints: unknown points bucket .*$/,
    /^\w+ transactions carry no (gcr_edits|nonce edit)$/,
    /^value edits with no counterpart in the regenerated set \(.*\)$/,
    /^expected exactly one nonce edit, got \d+$/,
]

// Refusals that can carry the node's computed fee or exception text are told
// as their category.
const ADMISSION_REASON_CATEGORIES: ReadonlyArray<[RegExp, string]> = [
    [/^gcr_edits verification error: /, "gcr_edits verification error"],
    [/^gcr_edits cannot be regenerated: /, "gcr_edits cannot be regenerated"],
    [
        /^(the network's \w+ is not an amount|transaction_fee\.\w+ mismatch): /,
        "transaction_fee mismatch",
    ],
]

/** What a client is told of an admission refusal, or undefined for nothing. */
function publicAdmissionReason(reason: string): string | undefined {
    // The gate refusals are read here, not in the set above: a gate module
    // reaches this one through sharedState, so loading the gate first runs
    // this module before the gate's constant exists.
    if (
        reason === L2PS_GATE_REFUSAL ||
        reason === TLSN_DISABLED_REFUSAL ||
        reason === TOKEN_STAKING_REFUSAL
    ) {
        return reason
    }
    if (PUBLIC_ADMISSION_REASONS.has(reason)) return reason
    if (PUBLIC_ADMISSION_SHAPES.some(shape => shape.test(reason))) return reason
    return ADMISSION_REASON_CATEGORIES.find(([shape]) => shape.test(reason))?.[1]
}

async function checkSenderFeeBalance(
    gcrEdits: GCREdit[],
    sender: string,
): Promise<void> {
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
}

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
        // A refusal already carries its reason (a launch gate, a signature,
        // a nonce); judging the edits of a refused transaction would only
        // replace that reason with an edit mismatch.
        if (!validationData.data.valid) return validationData

        const handleGcrEditsStart = Date.now()
        const gcrEdits = await generateGcrEdits(tx)
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
        let checksOut = txGcrEditsHash === gcrEditsHash
        let admissionReason: string | undefined
        // Once edits are bound, a transaction is accepted on the rule peers and
        // apply use, judged on the edits as they were signed.
        if ((await editBindingState()).active) {
            const verdict = await verifyAdmissionEdits({
                ...tx,
                content: { ...tx.content, gcr_edits: txShippedGcrEdits },
            } as Transaction)
            if (!verdict.ok) {
                log.error("[handleValidateTransaction] " + verdict.reason)
                admissionReason = publicAdmissionReason(verdict.reason)
            }
            checksOut = verdict.ok
        }

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
            throw new Error(
                admissionReason
                    ? `GCREdit mismatch: ${admissionReason}`
                    : "GCREdit mismatch",
            )
        }

        await checkSenderFeeBalance(gcrEdits, sender)
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
