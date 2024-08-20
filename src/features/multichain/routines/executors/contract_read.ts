import type { IOperation } from "@kynesyslabs/demosdk-http/types"
import * as multichain from "@kynesyslabs/demosdk-http/xm-localsdk"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"

export default async function handleContractRead(
    operation: IOperation,
    chainID: number,
) {
    console.log("[XM Method] Read contract")
    // Mainly EVM but let's let it open for weird chains
    // Workflow: loading the provider url in our configuration, creating an instance, parsing the request
    // and sending back the chain response as it is
    if (operation.is_evm) {
        // console.log(evmProviders)
        let providerUrl = evmProviders[operation.chain][operation.subchain] // REVIEW Error handling
        let evmInstance = multichain.EVM.createInstance(chainID, providerUrl) // REVIEW We should be connected
        console.log(
            `[XM Method] operation.chain: ${operation.chain}, operation.subchain: ${operation.subchain}`,
        )
        console.log(`[XM Method]: providerUrl: ${providerUrl}`)
        await evmInstance.connect()
        console.log("params: \n")
        console.log(operation.task.params)
        console.log("\n end params: \n")
        let params = operation.task.params // REVIEW Error handling
        console.log("parsed params: " + params)
        if (!params.address) {
            console.log("Missing address")
            return {
                result: "error",
                error: "Missing contract address",
            }
        }
        if (!params.abi) {
            console.log("Missing ABI")
            return {
                result: "error",
                error: "Missing contract ABI",
            }
        }
        if (!params.method) {
            console.log("Missing contract method")
            return {
                result: "error",
                error: "Missing contract method",
            }
        }
        // Getting a contract instance using the evm library
        console.log("getting contract instance")
        let contractInstance = await evmInstance.getContractInstance(
            params.address,
            params.abi,
        )
        const methodParams = JSON.parse(params.params)
        console.log("calling SC method: " + params.method)
        console.log("calling SC with args: " + params.params)
        console.log("params.params contents:", methodParams)
        // Convert the object values into an array
        const argsArray = Object.values(methodParams)
        const result = await contractInstance[params.method](...argsArray) // REVIEW Big IF
        console.log("result from EVM read call received")
        //console.log(result.toString())
        //console.log("end result")
        return {
            result: result,
            status: true,
        }
    } else {
        return {
            result: "error",
            error: "Not implemented yet: contract_read on non-EVM chains",
        }
    }
}
