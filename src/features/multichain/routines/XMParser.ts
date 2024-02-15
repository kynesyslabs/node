// INFO In this module is offloaded the parsing of XM requests
import * as multichain from "sdk/localsdk/multichain"
import * as fs from "fs"
import required from "src/utilities/required"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"

// NOTE We define multichain into global so that we can use it later
global.multichain = multichain

export interface ITask {
    type: string
    params: any // TODO Define a decent type for this and use it everywhere
    // TODO AND NOTE
    // Here the client should send
    // the signed transactions that it requires
    signedPayloads: any[]
}

// NOTE: We receive the operations as:
/*
multichain_operation: {
    name: IOperation,
    name: IOperation,
    ...
}
*/
export interface IOperation {
    chain: string
    subchain: string
    is_evm: boolean
    rpc: string
    task: ITask
}

export interface old_XMScript {
    operations: IOperation[]
}

export interface XMScript {
    multichain_operation: { [key: string]: IOperation }
}

class XMParser {
    // INFO Same as below but with file support
    static async loadFile(path: string): Promise<XMScript> {
        if (!fs.existsSync(path)) {
            console.log("The file does not exist.")
            return null
        }
        let script = fs.readFileSync(path, "utf8")
        return await XMParser.load(script)
    }

    // INFO Transforming a string in a XMScript
    static async load(script: string): Promise<XMScript> {
        // Let's ensure it is already an array
        if (!(script.startsWith("[") && script.endsWith("]"))) {
            script = "[" + script + "]"
        }
        let xmscript: XMScript = JSON.parse(script)
        return xmscript
    }

    // INFO Preparsing a script to be able to execute it later (e.g. checking the syntax)

    static async prepare(script: XMScript): Promise<XMScript> {
        let result: XMScript = script
        // TODO
        return result
    }

    // INFO This returns the results of the execution of the XMScript
    static async execute(fullscript: XMScript): Promise<any> {
        let results = {}
        let name: string, operation: IOperation
        // Iterating over the operations
        // TODO Enforce order
        for (
            let id = 0;
            id < Object.keys(fullscript.multichain_operation.operations).length;
            id++
        ) {
            try {
                name = Object.keys(fullscript.multichain_operation.operations)[
                    id
                ]
                console.log("[" + name + "] ")
                operation = fullscript.multichain_operation.operations[name]
                console.log("[XMParser]: full script operation")
                console.log(fullscript)
                console.log("[XMParser]: partial operation")
                console.log(operation)
                results[name] = await XMParser.executeOperation(operation)
                console.log("[RESULT]: " + results[name])
            } catch (e) {
                console.log("[XM EXECUTE] Error: " + e)
                results[name] = { result: "error", error: e }
            }
        }
        return results // REVIEW Is the type ok?
    }

    // INFO Only executes one operation
    static async executeOperation(operation: IOperation): Promise<any> {
        let result = {}

        // chainID is 0 except for EVM chains
        // NOTE This snippet is what we need to support all the EVM chains
        let chainID = 0
        if (operation.is_evm) {
            // Choosing the right chain ID
            // TODO Use online resources to get the chain ID infos

            chainID = parseInt(operation.subchain, 10)
            if (isNaN(chainID)) {
                chainID = chainIds[operation.chain][operation.subchain]
                if (isNaN(chainID)) {
                    return {
                        result: "error",
                        error: "Invalid chain or subchain",
                    }
                }
            }
        }

        // REVIEW Would this work?
        // Read operations
        // let res = await multichain[operation.chain][operation.task.type](operation.task.params)

        // NOTE Deciding the operations

        // TODO Checking if we have a conditional operation

        // ANCHOR MVP
        /* SECTION Write tasks */
        // NOTE For the following tasks we need to check the signed payloads against checkSignedPayloads()

        // INFO Pay task
        // console.log(JSON.stringify(operation))
        if (operation.task?.type === "pay") {
            console.log(
                "[XMScript Parser] Pay task. Examining payloads (require 1)...",
            )
            // NOTE Generic sanity check on payloads
            if (!checkSignedPayloads(1, operation.task.signedPayloads)) {
                console.log(
                    "[XMScript Parser] Pay task failed: Invalid payloads (require 1 has 0)",
                )
                return {
                    result: "error",
                    error: "Invalid signedPayloads length",
                }
            }
            console.log(
                "[XMScript Parser] Pay task payloads are ok: Valid payloads (require 1 has 1)",
            )
            // ANCHOR EVM (which is quite simple: send a signed transaction. Done.)
            if (operation.is_evm) {
                console.log(
                    "[XMScript Parser] EVM Pay: trying to send the payload as a signed transaction...",
                ) // REVIEW Simulations?
                console.log(chainID)

                console.log(operation.task.signedPayloads)

                console.log(operation.task.signedPayloads[0])

                let evmInstance = await multichain.EVM.getInstance(chainID)

                if (!evmInstance) {
                    evmInstance = await multichain.EVM.createInstance(
                        chainID,
                        evmProviders[operation.chain][operation.subchain],
                    )
                    await evmInstance.connect(
                        evmProviders[operation.chain][operation.subchain],
                    )
                }

                result = await multichain.EVM.getInstance(
                    chainID,
                ).sendSignedTransaction(operation.task.signedPayloads[0])
            }
            // Non EVM Section has more complexity
            else {
                console.log("[XMScript Parser] Non-EVM PAY")
                // ANCHOR Ripple
                if (operation.chain == "xrpl") {
                    console.log(
                        `[XMScript Parser] Ripple Pay: ${operation.chain} on ${operation.subchain}`,
                    )
                    // Testnet support
                    let rpc_url =
                        chainProviders[operation.chain][operation.subchain]
                    console.log(
                        `[XMScript Parser] Ripple Pay: we will use ${rpc_url} to connect to ${operation.chain} on ${operation.subchain}`,
                    )
                    console.log(
                        "[XMScript Parser] Ripple Pay: trying to send the payload as a signed transaction...",
                    ) // REVIEW Simulations?
                    let xrplInstance = new multichain.XRPL(rpc_url)
                    xrplInstance.connect(rpc_url)

                    // REVIEW 10 seconds timeout for connection
                    let timer = 0
                    while (!xrplInstance.connected) {
                        await new Promise(resolve => setTimeout(resolve, 300))
                        timer += 300
                        if (timer > 10000) {
                            console.log("[XMScript Parser] Ripple Pay: timeout")
                            return {
                                result: "error",
                                error: "Timeout in connecting to the XRP network",
                            }
                        }
                    }
                    console.log(
                        "[XMScript Parser] Ripple Pay: connected to the XRP network",
                    )

                    try {
                        console.log("[XMScript Parser]: debugging operation")
                        console.log(operation.task)
                        console.log(JSON.stringify(operation.task))
                        result = await xrplInstance.sendTransaction(
                            operation.task.signedPayloads[0],
                        )
                        console.log("[XMScript Parser] Ripple Pay: result: ")
                        console.log(result)
                    } catch (error) {
                        console.log("[XMScript Parser] Ripple Pay: error: ")
                        console.log(error)
                        result = error
                    }
                }

                if (operation.chain == "egld") {
                    console.log(
                        `[XMScript Parser] EGLD Pay: ${operation.chain} on ${operation.subchain}`,
                    )
                    const rpc_url =
                        chainProviders[operation.chain][operation.subchain]

                    const mxInstance = new multichain.MULTIVERSX(rpc_url)

                    try {
                        // INFO: Connect and wait for the connection to be verified
                        await mxInstance.connect()
                    } catch (error) {
                        return {
                            result: "error",
                            error: error,
                        }
                    }

                    try {
                        const signedTx = operation.task.signedPayloads[0]
                        const txHash = await mxInstance.sendTransaction(
                            signedTx,
                        )
                        console.log("[XMScript Parser] EGLD Pay: result: ")
                        console.log(txHash)

                        result = {
                            tx_hash: txHash,
                        }
                    } catch (error) {
                        console.log("[XMScript Parser] EGLD Pay: error: ")
                        console.log(error)
                        result = error
                    }
                }
            }

            return result // REVIEW is this ok here?
        }

        /* SECTION Read only tasks */
        // NOTE For the following tasks, we can safely skip checkSignedPayloads()

        // ANCHOR MVP
        // INFO Read contract task
        else if (operation.task?.type == "contract_read") {
            console.log("[XM Method] Read contract")
            // Mainly EVM but let's let it open for weird chains
            // Workflow: loading the provider url in our configuration, creating an instance, parsing the request
            // and sending back the chain response as it is
            if (operation.is_evm) {
                // console.log(evmProviders)
                let providerUrl =
                    evmProviders[operation.chain][operation.subchain] // REVIEW Error handling
                let evmInstance = await multichain.EVM.createInstance(
                    chainID,
                    providerUrl,
                ) // REVIEW We should be connected
                console.log(
                    `[XM Method] operation.chain: ${operation.chain}, operation.subchain: ${operation.subchain}`,
                )
                console.log(`[XM Method]: providerUrl: ${providerUrl}`)
                await evmInstance.connect(providerUrl)
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
                result = await contractInstance[params.method](...argsArray) // REVIEW Big IF
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
    }
}

// INFO Each non-read task has to be checked here
function checkSignedPayloads(num: number, signedPayloads: any[]): boolean {
    // NOTE Sanity check on the signedPayloads length
    let sanityCheck = required(
        signedPayloads.length == num,
        "Invalid signedPayloads length",
    )

    if (!sanityCheck) {
        return false
    }

    console.log("[XMScript Parser] Signed payload seems ok.")
    return true
}

export default XMParser
