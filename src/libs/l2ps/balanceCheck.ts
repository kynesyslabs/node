/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { Transaction } from "@/types/blockchain/Transaction"
import type { INativePayload } from "@kynesyslabs/demosdk/types"
import { canonicalizeAmountToOs } from "@/forks/amountCanonical"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"
import L2PSTransactionExecutor, {
    L2PS_TX_FEE,
} from "./L2PSTransactionExecutor"

/**
 * Shared L2PS balance pre-check used by both `handleL2PS.checkSenderBalance`
 * and `validateTransaction.checkL2PSBalance`. Keeping the two call sites
 * on one implementation prevents the unit-mismatch / fee-scoping bugs
 * they were both shipping independently.
 *
 * Returns:
 *   - error string when the sender has insufficient balance OR the inner
 *     tx is malformed in a way we can describe
 *   - null when the inner tx is genuinely fee-free OR the balance covers
 *     the total required
 *
 * Critically: the comparison is done entirely in **OS units** so the
 * pre-check matches what the executor actually does. Before this helper
 * existed, the call sites added `L2PS_TX_FEE` (DEM, value `1`) and
 * `sendAmount` (DEM) but compared against `getBalance()` which returns
 * the post-fork OS magnitude (~10⁹× larger). That made the gate a
 * silent no-op for any real wallet post-osDenomination.
 */
export async function checkInnerTxBalance(
    decryptedTx: Transaction,
): Promise<string | null> {
    const sender = decryptedTx.content.from as string
    if (!sender) return "Missing sender address in decrypted transaction"

    const feeBearing = isFeeBearing(decryptedTx)
    if (!feeBearing) return null

    let amountRaw: number | string
    try {
        amountRaw = extractNativeSendAmount(decryptedTx)
    } catch (e) {
        return `Invalid native send amount: ${(e as Error).message}`
    }

    const referenceHeight = getSharedState.lastBlockNumber ?? 0
    const forkActive = isForkActive("osDenomination", referenceHeight)

    let amountCanonical: bigint
    let feeCanonical: bigint
    try {
        // canonicalizeAmountToOs accepts both number and string and
        // returns the OS-unit BigInt — matches the executor's burn /
        // debit logic exactly so the pre-check and the actual debit
        // can never disagree on units.
        amountCanonical = canonicalizeAmountToOs(amountRaw, forkActive)
        feeCanonical = canonicalizeAmountToOs(L2PS_TX_FEE, forkActive)
    } catch (e) {
        return `Invalid native send amount: ${(e as Error).message}`
    }

    const totalRequired = amountCanonical + feeCanonical
    if (totalRequired === 0n) return null

    try {
        const balance = await L2PSTransactionExecutor.getBalance(sender)
        if (balance < totalRequired) {
            return `Insufficient balance: need ${totalRequired} (${amountCanonical} + ${feeCanonical} fee) but have ${balance}`
        }
    } catch (error) {
        return `Balance check failed: ${error instanceof Error ? error.message : "Unknown error"}`
    }

    return null
}

/**
 * Mirrors `L2PSTransactionExecutor.handleNativeTransaction()`, which
 * only burns `L2PS_TX_FEE` on `native` / `send`. Any other tx type is
 * fee-free at this layer.
 */
function isFeeBearing(decryptedTx: Transaction): boolean {
    if (decryptedTx.content.type !== "native") return false
    const data = decryptedTx.content.data
    if (!Array.isArray(data)) return false
    const payload = data[1] as INativePayload | undefined
    return payload?.nativeOperation === "send"
}

/**
 * Returns the raw `sendAmount` (number or string) from a `native/send`
 * tx without coercing — `canonicalizeAmountToOs` handles both shapes.
 * Throws a clear error for malformed values rather than silently
 * defaulting to 0.
 */
function extractNativeSendAmount(decryptedTx: Transaction): number | string {
    const payload = (decryptedTx.content.data as any[])[1] as INativePayload
    const [, sendAmount] = payload.args as [string, number | string]

    // number: must be a finite, non-negative number
    if (typeof sendAmount === "number") {
        if (!Number.isFinite(sendAmount) || sendAmount < 0) {
            throw new Error(`got numeric ${String(sendAmount)}`)
        }
        return sendAmount
    }
    // string: must be a non-empty digit string (canonicalizeAmountToOs
    // will reject anything more exotic)
    if (typeof sendAmount === "string") {
        if (sendAmount === "" || /^[-]/.test(sendAmount)) {
            throw new Error(`got string ${JSON.stringify(sendAmount)}`)
        }
        return sendAmount
    }
    throw new Error(`got non-numeric value of type ${typeof sendAmount}`)
}
