import sharedState, { getSharedState} from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"

import Chain from "../chain"
import GLS from "../gls/gls"
import Transaction from "../transaction"

// INFO Calculating transaction fees based on the size of the transaction and the status of the chain
async function calculateComposedGas(): Promise<number> {
    let lastblock_basegas: number = await GLS.getGLSLastBlockBaseGas()
    // Congestion check
    let factor = await adaptGasToCongestion()
    let adapted_gas = lastblock_basegas * factor
    // Adding the fee for the rpc
    // TODO Set limits for the fee
    let composed_gas = adapted_gas + getSharedState.rpcFee
    // TODO Add dApp fees
    return composed_gas
}

// REVIEW This function is used to adapt the gas to congestion. It increases the gas if needed
async function adaptGasToCongestion(): Promise<number> {
    // TODO Get last block and previous last block timestamps
    let lastBlockNumber = await Chain.getLastBlockNumber()
    // Support for genesis block
    if (lastBlockNumber == 0) {
        return 0
    }
    let previousLastBlockNumber = lastBlockNumber - 1
    // Getting blocks
    let lastBlock = await Chain.getBlockByNumber(lastBlockNumber)
    let previousLastBlock = await Chain.getBlockByNumber(
        previousLastBlockNumber,
    )
    // Getting timestamps
    let lastBlockTimestamp = lastBlock.content.timestamp
    let previousLastBlockTimestamp = previousLastBlock.content.timestamp
    // Calculating the difference between the two timestamps
    let difference = lastBlockTimestamp - previousLastBlockTimestamp
    // Get the block time from the chain status (in seconds, so we multiply by 1000)
    let block_time = getSharedState.block_time * 1000
    // Calculating the factor
    let factor: number = 1
    if (difference > block_time) {
        let drift = difference - block_time
        factor = 1 + (1.5 * drift / block_time) // REVIEW Is this correct?
    }
    return factor
}

// REVIEW Why is this just a nested call
export default async function calculateCurrentGas(payload: any): Promise<number> {
    let payload_size = sizeOf(payload)
    let composed_gas_price = await calculateComposedGas()
    let transaction_fee = payload_size * composed_gas_price
    return transaction_fee
}
