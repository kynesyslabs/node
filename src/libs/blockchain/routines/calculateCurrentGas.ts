import sharedState from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"

import Chain from "../chain"
import GLS from "../gls/gls"
import Transaction from "../transaction"

// INFO Calculating transaction fees based on the size of the transaction and the status of the chain
async function calculateComposedGas(): Promise<number> {
    let lastblock_basegas: number = await GLS.getGLSLastBlockBaseGas()
    // TODO Add something to check congestion
    let composed_gas = lastblock_basegas + sharedState.getInstance().rpcFee
    // TODO Add dApp fees
    return composed_gas
}

// REVIEW Why is this just a nested call
export default async function calculateCurrentGas(payload: any): Promise<number> {
    let payload_size = sizeOf(payload)
    let composed_gas_price = await calculateComposedGas()
    let transaction_fee = payload_size * composed_gas_price
    return transaction_fee
}
