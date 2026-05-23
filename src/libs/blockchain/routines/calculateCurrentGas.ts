import { getSharedState } from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"

import Chain from "../chain"
import GCR from "../gcr/gcr"
import Transaction from "../transaction"

/**
 * Split fee breakdown returned by {@link calculateFeeBreakdown}.
 *
 * DEM-665: post-fork the fee-distribution logic in
 * `gcr_routines/feeDistribution.ts` reads each component separately so it
 * can route the burn / treasury / rpc-operator shares per the genesis
 * distribution rules (50/50, 25/75, 25/50/25 by default; governable from
 * day 1 via NetworkParameters in P13).
 *
 * `additional_fee` is reserved for future dApp-paid fees — the SDK type
 * already carries it but the post-fork distribution sets it to 0 until a
 * concrete dApp fee path lands.
 */
export interface FeeBreakdown {
    /** Network share — paid by sender; routed burn% / treasury%. */
    network_fee: number
    /** RPC operator share — paid by sender; routed 100% to rpc_address. */
    rpc_fee: number
    /** dApp-paid extras share — reserved; routed burn% / treasury%. */
    additional_fee: number
    /** Sum of all components — what a sender's balance is checked against. */
    total: number
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

/**
 * Calculate per-component fees for a transaction.
 *
 * Reads the per-byte component prices from shared state (mirrored by
 * `loadNetworkParameters` from the active NetworkUpgrade row or env-resolved
 * defaults — see `src/utilities/sharedState.ts` for the slots):
 *   - `networkFee`: per-byte network component
 *   - `rpcFee`: per-byte rpc-operator component
 *
 * Multiplies each by the surge factor and (when surge pricing is
 * re-enabled) by payload size. `additional_fee` is currently 0 —
 * placeholder for the future dApp-paid path described in the DEM-665 spec.
 *
 * Note: the deprecated `burnFee` shared-state scalar is intentionally NOT
 * read here. Post-fork the burned share comes out of the per-component
 * distribution percentages (e.g. `networkFeeBurnPct`), not as a separate
 * line item — P13 finishes the migration of distribution percentages
 * into NetworkParameters and P8 retires the scalar.
 */
export async function calculateFeeBreakdown(
    payload: unknown,
): Promise<FeeBreakdown> {
    void Transaction
    const payloadSize = sizeOf(payload)
    void payloadSize
    const surge = await dynamicSurgeMultiplier()

    // Today (flat-fee era): payloadSize does not multiply in. When surge
    // pricing comes back, multiply each component by `payloadSize` here.
    const network_fee = getSharedState.networkFee * surge
    const rpc_fee = getSharedState.rpcFee * surge
    // DEM-665 (PR #817 Greptile P1): read additional_fee from shared
    // state so governance changes via NetworkParameters actually take
    // effect on the collection path. Defaults to 0 (matches the
    // hardcoded fallback); raising it via a governance proposal that
    // passes safetyBounds will start charging it on the next tx.
    const additional_fee = getSharedState.additionalFee * surge

    return {
        network_fee,
        rpc_fee,
        additional_fee,
        total: network_fee + rpc_fee + additional_fee,
    }
}

/**
 * Compose the per-byte gas price for a transaction.
 *
 * Today every tx pays a flat fee made of three equal components:
 *   networkFee + rpcFee + burnFee = 1 + 1 + 1 = 3
 *
 * No congestion adjustment is applied — `dynamicSurgeMultiplier()` above
 * is intentionally a stub returning 1. When we re-enable surge pricing
 * we'll plumb a real factor through that seam without touching the
 * call sites.
 *
 * Kept on the legacy three-scalar shape (networkFee + rpcFee + burnFee)
 * so pre-fork callers — `determineGasForOperation`, `txToGCROperation`,
 * the dead-code `defineGas` path in validateTransaction — observe the
 * exact same total as before DEM-665. Post-fork the fee-distribution
 * logic uses {@link calculateFeeBreakdown} instead and the burnFee scalar
 * is retired by P8/P13.
 */
async function calculateComposedGas(): Promise<number> {
    const flatFee =
        getSharedState.networkFee +
        getSharedState.rpcFee +
        getSharedState.burnFee
    const surge = await dynamicSurgeMultiplier()
    return flatFee * surge
}

/**
 * Legacy total-fee entry point.
 *
 * @deprecated DEM-665: post-fork callers use
 * {@link calculateFeeBreakdown} so the per-component shares are visible
 * to the fee-distribution edit generator. This default export remains for
 * pre-fork compatibility with `determineGasForOperation`,
 * `txToGCROperation`, and the dead-code `defineGas` path — it returns
 * the legacy three-scalar sum (networkFee + rpcFee + burnFee, scaled by
 * surge), not the new breakdown total. Once burnFee is removed (P8/P13)
 * this function can simply forward to `calculateFeeBreakdown(payload).total`.
 */
export default async function calculateCurrentGas(
    payload: unknown,
): Promise<number> {
    void Transaction
    const payloadSize = sizeOf(payload)
    void payloadSize
    // Today: flat-fee-only — payload size does not affect cost. When
    // surge pricing comes back, multiply by payloadSize here (or fold
    // it into calculateComposedGas).
    return calculateComposedGas()
}
