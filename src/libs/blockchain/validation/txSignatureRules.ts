import type { Transaction } from "@kynesyslabs/demosdk/types"

import { isForkActive } from "@/forks/forkGates"
import { txSignatureContext } from "@/forks/signatureDomainGate"
import TxValidatorPool from "./txValidatorPool"
import { isSystemRelayTx } from "./systemRelayTx"
import type { TxValidationResult } from "./types"

export interface SignatureRules {
    signatureDomain: ReturnType<typeof txSignatureContext>
    isPostFork: boolean
}

/** The signature and amount rules in force at `height`; throws if the chain id cannot be resolved. */
export function signatureRulesAt(height: number): SignatureRules {
    return {
        signatureDomain: txSignatureContext(height),
        isPostFork: isForkActive("osDenomination", height),
    }
}

export function verdictsUnder(
    rules: SignatureRules,
    txs: Transaction[],
): Promise<TxValidationResult[]> {
    return TxValidatorPool.getInstance().validate(
        txs,
        rules.isPostFork,
        rules.signatureDomain,
    )
}

/**
 * Whether a transaction is signed by a PQC key alone, so its validity rests
 * on the signer's identity record rather than on its own signatures.
 */
export function isPqcOnlyTx(tx: Transaction): boolean {
    const type = (tx as { signature?: { type?: unknown } }).signature?.type
    return (
        typeof type === "string" &&
        type !== "ed25519" &&
        !tx.ed25519_signature &&
        !isSystemRelayTx(tx)
    )
}

/**
 * The PQC-only transactions among `txs` that a node syncing block `height`
 * would refuse, judged by the check `verifyBlockTxSignatures` runs on a synced
 * block and on the identity records as they stand now. A forger calls it on
 * the state the block is built on, which is the state a syncing node holds when it
 * checks that block, so a key removed in an earlier block refuses the
 * transaction on both sides. Others are not judged: admission already
 * checked their signatures, which state cannot change.
 *
 * @returns hash -> reason for each transaction to leave out.
 */
export async function pqcTxsRefusedAt(
    height: number,
    txs: Transaction[],
): Promise<Map<string, string>> {
    const refused = new Map<string, string>()
    const pqcOnly = txs.filter(isPqcOnlyTx)
    if (pqcOnly.length === 0) return refused
    const results = await verdictsUnder(signatureRulesAt(height), pqcOnly)
    for (let i = 0; i < results.length; i++) {
        if (!results[i].valid) {
            refused.set(pqcOnly[i].hash, results[i].reason ?? "invalid signature")
        }
    }
    return refused
}
