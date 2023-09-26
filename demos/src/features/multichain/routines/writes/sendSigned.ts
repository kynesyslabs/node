// INFO pay module for the supported chains
import { IOperation } from "../../XMParser"
import * as mc from "sdk/localsdk"
const multichain = mc.multichain
import required from "src/utilities/required"
import DefaultChain from "sdk/localsdk/multichain/types/defaultChain"

// TODO Better error handling
export default async function sendSigned(
    operation: IOperation,
    chainInstance: DefaultChain = null): Promise<[boolean, any]>{
    // Basic check: do we have a payload?
    let signedPayload: any
    try {
        signedPayload = operation.signedPayloads[0]
    } catch (e) {
        return [false, e]
    }
    // TODO Should be good to verify that the signed payload is correct
    let {chain} = operation
    let subchain = Number(operation.subchain) // REVIEW This has to be numbered
    // ANCHOR Chain division
    let result: any
    // EVM Chains have their own instance registry to manage them all together
    if (operation.is_evm) {
        required(multichain.EVM.getInstance(subchain), "No EVM chains connected")
        result = await multichain.EVM.getInstance(subchain).sendTransaction(
            signedPayload, // REVIEW Big IF
        )
        return [true, result]
    }
    // NON EVM Chains are standardized through the defaultChain implementation
    // TODO We can connect autonomously without erroring
    required(chainInstance, "No chain initialized for this operation")
    required(chainInstance.name === chain, "This specific chain is not connected")
    // NOTE Theoretically every chain accepts this precise method
    result = await chainInstance.sendTransaction(
        signedPayload,
    )
    return [true, result]


}