// INFO This module is responsible for understanding how gas is paid by the client and where it is paid
import determineGasForOperation from "./determineGasForOperation"

export interface GasDeal {
    proposed_chain: string
    amount_in_ref_currency: number
    amount_in_native_currency: number
    ref_currency: string // As in USDT, USDC, DAI, DEMOS Token, etc
    ref_currency_feed: string // REVIEW As an url or we create this mechanism elsewhere?
}

export default async function gasDeal(
    proposed_chain: string,
    payload: any,
): Promise<GasDeal> {
    // Generating a skeleton gas deal
    let gas_deal: GasDeal = {
        proposed_chain: proposed_chain,
        amount_in_ref_currency: null,
        amount_in_native_currency: null,
        ref_currency: null,
        ref_currency_feed: null,
    }
    let gas_required = await determineGasForOperation(payload) // In DEMOS
    // TODO Somehow convert gas in the reference currency
    // TODO Use the below functions to get the native and reference currency of the chain and calculate the conversion
    let reference_currency = await getChainReferenceCurrency(proposed_chain)
    let native_to_ref_conversion_rate =
        await getChainNativeToReferenceConversionRate(proposed_chain)
    let native_to_demos_conversion_rate =
        await getChainNativeToDEMOSConversionRate(proposed_chain)
    let amount_in_native_currency =
        gas_required * native_to_demos_conversion_rate
    let amount_in_ref_currency =
        amount_in_native_currency * native_to_ref_conversion_rate
    // TODO Calculate the amount in the reference currency
    gas_deal.amount_in_ref_currency = amount_in_ref_currency
    gas_deal.amount_in_native_currency = amount_in_native_currency
    gas_deal.ref_currency = reference_currency
    gas_deal.ref_currency_feed = "example"
    // TODO Generate a gas deal based on the proposed chain and the payload using determineGasForOperation
    return gas_deal
}

export async function getChainReferenceCurrency(
    chain: string,
): Promise<string> {
    // TODO Return the reference currency of the chain
    return "USDT"
}

export async function getChainNativeToReferenceConversionRate(
    chain: string,
): Promise<number> {
    // TODO Return the conversion rate from the native currency to the reference currency
    return 1
}

export async function getChainNativeToDEMOSConversionRate(
    chain: string,
): Promise<number> {
    // TODO Return the conversion rate from the native currency to DEMOS
    return 1
}
