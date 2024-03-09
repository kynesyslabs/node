import Transaction from "../transaction"
import Chain from "../chain"
import GLS from "../gls/gls"
import sizeOf from "src/utilities/sizeOf"
import sharedState from "src/utilities/sharedState"

// INFO Calculating transaction fees based on the size of the transaction and the status of the chain
async function calculateComposedGas(): Promise<number> {
    let lastblock_basegas: number = await GLS.getGLSLastBlockBaseGas()
    // TODO Add something to check congestion
    let tx_fee = lastblock_basegas + sharedState.getInstance().rpcFee
    // TODO Add dApp fees
    return tx_fee
}

// REVIEW Why is this just a nested call
export default async function calculateCurrentGas(): Promise<number> {
    let composed_gas_price = await calculateComposedGas()
    return composed_gas_price
}
