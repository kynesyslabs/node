import Transaction from "../transaction"
import Chain from "../chain"
import GLS from "../gls/gls"
import sizeOf from "src/utilities/sizeOf"

// INFO Calculating transaction fees based on the size of the transaction and the status of the chain
export default async function calculateCurrentGas (payload: Transaction): Promise<number> {
    let tx_size = sizeOf(payload)
    let constant_multiplier = await GLS.getGLSGasMultiplier()
    let tx_fee = tx_size * constant_multiplier
    return tx_fee
}

