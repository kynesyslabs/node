import Transaction from "../transaction"
import Chain from "../chain"
import GLS from "../gls/gls"
import sizeOf from "src/utilities/sizeOf"
import sharedState from "src/utilities/sharedState"

// INFO Calculating transaction fees based on the size of the transaction and the status of the chain
async function calculateComposedGas(): Promise<number> {
    let constant_multiplier: number = await GLS.getGLSGasMultiplier()
    // TODO Add something to check congestion
    let tx_fee = constant_multiplier + sharedState.getInstance().rpcFee
    // TODO Add dApp fees
    return tx_fee
}

export default async function calculateCurrentGas(
    payload: Transaction,
): Promise<number> {
    let tx_size = sizeOf(payload)
    let composed_gas_price = await calculateComposedGas()
    let tx_fee = tx_size * composed_gas_price
    return tx_fee
}
