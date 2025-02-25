import { DemosWork } from "@kynesyslabs/demosdk/demoswork"
import { DemoScript, Transaction } from "@kynesyslabs/demosdk/types"
import GCROperation from "src/libs/blockchain/gcr/types/GCROperations" // ! Put it in the sdk
import { forgeToHex } from "src/libs/crypto/forgeUtils"
import calculateCurrentGas from "../../routines/calculateCurrentGas"

/** NOTE
 * Once a block is forged, the createBlock method hash the two GCR tables and adds the hashes to the block
 */

/** REVIEW
 * In the PoRBFT routine, before generating the block, the operations are applied to the state
 * Consequently, the PoRBFT routine check the state hashes and add them to the block.
 */

// REVIEW This should convert a transaction to an operation
export async function txToGCROperation(tx: Transaction): Promise<GCROperation> {
    const operation: GCROperation = {
        address: "",
        data: null,
        gas: 0,
    }
    // Extract the address from the transaction
    let address: string
    if (typeof tx.content.from !== "string") {
        address = forgeToHex(tx.content.from)
    } else {
        address = tx.content.from
    }
    operation.address = address
    // Extract the data from the transaction as a DemosWork
    operation.data = tx.content.data[1] as DemoScript
    // Calculate the gas used
    operation.gas = await calculateCurrentGas(operation.data)
    // Return the operation
    return operation
}
