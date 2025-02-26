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
    proposedChain: string,
    payload: any,
): Promise<GasDeal> {
    // Generating a skeleton gas deal
    const gasDeal: GasDeal = {
        proposed_chain: proposedChain,
        amount_in_ref_currency: null,
        amount_in_native_currency: null,
        ref_currency: null,
        ref_currency_feed: null,
    }
    const gasRequired = await determineGasForOperation(payload) // In DEMOS
    // TODO Somehow convert gas in the reference currency
    // TODO Use the below functions to get the native and reference currency of the chain and calculate the conversion
    const referenceCurrency = await getChainReferenceCurrency(proposedChain)
    const nativeToRefConversionRate =
        await getChainNativeToReferenceConversionRate(proposedChain)
    const nativeToDemosConversionRate =
        await getChainNativeToDEMOSConversionRate(proposedChain)
    const amountInNativeCurrency =
        gasRequired * nativeToDemosConversionRate
    const amountInRefCurrency =
        amountInNativeCurrency * nativeToRefConversionRate
    // TODO Calculate the amount in the reference currency
    gasDeal.amount_in_ref_currency = amountInRefCurrency
    gasDeal.amount_in_native_currency = amountInNativeCurrency
    gasDeal.ref_currency = referenceCurrency
    gasDeal.ref_currency_feed = "example"
    // TODO Generate a gas deal based on the proposed chain and the payload using determineGasForOperation
    return gasDeal
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
