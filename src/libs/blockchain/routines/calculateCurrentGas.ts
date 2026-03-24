import { getSharedState } from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"

import Chain from "../chain"
import GCR from "../gcr/gcr"
import Transaction from "../transaction"

// INFO Calculating transaction fees based on the size of the transaction and the status of the chain
async function calculateComposedGas(): Promise<number> {
    const lastBlockBaseGas: number = await GCR.getGCRLastBlockBaseGas()
    // Congestion check
    const factor = await adaptGasToCongestion()
    const adaptedGas = lastBlockBaseGas * factor
    // Adding the fee for the rpc
    // TODO Set limits for the fee
    const composedGas = adaptedGas + getSharedState.rpcFee
    // TODO Add dApp fees
    return composedGas
}

// REVIEW This function is used to adapt the gas to congestion. It increases the gas if needed
async function adaptGasToCongestion(): Promise<number> {
    // TODO Get last block and previous last block timestamps
    const lastBlockNumber = await Chain.getLastBlockNumber()
    // Support for genesis block
    if (lastBlockNumber === 0) {
        return 0
    }
    const previousLastBlockNumber = lastBlockNumber - 1
    // Getting blocks
    const lastBlock = await Chain.getBlockByNumber(lastBlockNumber)
    const previousLastBlock = await Chain.getBlockByNumber(
        previousLastBlockNumber,
    )
    // Getting timestamps
    const lastBlockTimestamp = lastBlock.content.timestamp
    const previousLastBlockTimestamp = previousLastBlock.content.timestamp
    // Calculating the difference between the two timestamps
    const difference = lastBlockTimestamp - previousLastBlockTimestamp
    // Get the block time from the chain status (in seconds, so we multiply by 1000)
    const blockTime = getSharedState.block_time * 1000
    // Calculating the factor
    let factor = 1
    if (difference > blockTime) {
        const drift = difference - blockTime
        factor = 1 + (1.5 * drift) / blockTime // REVIEW Is this correct?
    }
    return factor
}

// REVIEW Why is this just a nested call
export default async function calculateCurrentGas(
    payload: any,
): Promise<number> {
    const payloadSize = sizeOf(payload)
    const composedGasPrice = await calculateComposedGas()
    const transactionFee = payloadSize * composedGasPrice
    return transactionFee
}
