import calculateCurrentGas from "src/libs/blockchain/routines/calculateCurrentGas"
import { demostdlib } from "src/libs/utils"

export default async function determineGasForOperation(
    operation: any,
): Promise<number> {
    // Calculating byte size of the operation
    let byte_size = demostdlib.payloadSize(operation)
    // Getting the base gas from the chain status (GCR)
    let base_gas = await calculateCurrentGas(operation)
    // INFO The gas required for an operation is the base gas multiplied by the byte size
    let operation_gas = base_gas * byte_size

    // TODO Enable when the function is ready
    //return operation_gas

    return 0
}
