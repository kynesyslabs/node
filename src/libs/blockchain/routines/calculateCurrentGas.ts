import { getSharedState } from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"

import Chain from "../chain"
import GCR from "../gcr/gcr"
import Transaction from "../transaction"

/**
 * Compose the per-byte gas price for a transaction.
 *
 * Today every tx pays a flat fee made of three equal components:
 *   networkFee + rpcFee + burnFee = 1 + 1 + 1 = 3
 *
 * No congestion adjustment is applied — `dynamicSurgeMultiplier()` below
 * is intentionally a stub returning 1. When we re-enable surge pricing
 * we'll plumb a real factor through that seam without touching the
 * call sites.
 *
 * TODO(decimals): once OS denomination ships, the three components
 * must add up to exactly 1 DEM (≈ 333_333_333 OS each, exact split
 * TBD). See `decimal_planning/SPEC.md` and Mycelium epic E#3.
 */
async function calculateComposedGas(): Promise<number> {
    const flatFee =
        getSharedState.networkFee +
        getSharedState.rpcFee +
        getSharedState.burnFee
    // Stub seam: returns 1 today. Re-enabling congestion pricing means
    // restoring the lastBlockBaseGas * adaptedFactor * payloadSize math
    // and adding it to flatFee here.
    const surge = await dynamicSurgeMultiplier()
    return flatFee * surge
}

/**
 * Future congestion-pricing seam.
 *
 * Returns 1 today — total tx cost is purely the flat fee. The legacy
 * implementation read `GCR.getGCRLastBlockBaseGas()` and the inter-block
 * timestamp drift to scale gas above the flat fee when blocks ran slow.
 * Wired through here so re-enabling it later is a one-function change.
 */
async function dynamicSurgeMultiplier(): Promise<number> {
    // Reference reads, kept so the surrounding wiring (lastBlockNumber +
    // base gas) doesn't break at runtime if a downstream consumer still
    // expects them. Replace with the real `1 + (drift / blockTime)` math
    // once we re-enable surge pricing.
    void Chain
    void GCR
    return 1
}

// REVIEW Why is this just a nested call
export default async function calculateCurrentGas(
    payload: any,
): Promise<number> {
    void Transaction
    const payloadSize = sizeOf(payload)
    void payloadSize
    const composedGas = await calculateComposedGas()
    // Today: flat-fee-only — payload size does not affect cost. When
    // surge pricing comes back, multiply by payloadSize here (or fold
    // it into calculateComposedGas).
    return composedGas
}
