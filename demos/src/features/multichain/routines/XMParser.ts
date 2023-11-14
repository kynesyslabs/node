// INFO In this module is offloaded the parsing of XM requests
import * as multichain from "sdk/localsdk/multichain"
import sendSigned from "./writes/sendSigned"
import * as fs from "fs"
import required from "src/utilities/required"

// NOTE We define multichain into global so that we can use it later
global.multichain = multichain

// REVIEW Define XMScript (chs) class?

export interface ITask {
    type: string
    params: {}
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
        for (
            let id = 0;
            id < Object.keys(fullscript.multichain_operation).length;
            id++
        ) {
            name = Object.keys(fullscript.multichain_operation)[id]
            operation = fullscript.multichain_operation[name]
            results[name] = await XMParser.executeOperation(operation)
        }
    }

    // INFO Only executes one operation
    static async executeOperation(operation: IOperation): Promise<any> {
        let result = {}

        // NOTE chainID is 0 except for EVM chains
        // This snippet is what we need to support all the EVM chains
        let chainID = 0
        if (operation.is_evm) {
            // Choosing the right chain ID
            if (operation.chain == "ethereum") {
                if (operation.subchain == "mainnet") {
                    chainID = 1
                } else if (operation.subchain == "ropsten") {
                    chainID = 3
                } else if (operation.subchain == "rinkeby") {
                    chainID = 4
                } else if (operation.subchain == "goerli") {
                    chainID = 5
                }
            } else if (operation.chain == "bsc") {
                if (operation.subchain == "mainnet") {
                    chainID = 56
                } else if (operation.subchain == "testnet") {
                    chainID = 97
                }
            }
            // Fallback on direct chain id
            else {
                // Subchain must be a number
                chainID = parseInt(operation.subchain)
                if (isNaN(chainID)) {
                    console.log("Invalid subchain")
                    return { result: "error", error: "Invalid subchain" }
                }
            }
        }

        // REVIEW Would this work?
        // Read operations
        // let res = await multichain[operation.chain][operation.task.type](operation.task.params)

        // NOTE Deciding the operations
        // TODO Checking if we have a conditional operation
        // Types
        if (operation.task.type == "pay") {
            // NOTE Generic sanity check on payloads
            if (!checkSignedPayloads(1, operation.task.signedPayloads)) {
                return {
                    result: "error",
                    error: "Invalid signedPayloads length",
                }
            }
            // ANCHOR EVM
            if (operation.is_evm) {
                console.log("[XMScript Parser] EVM Pay")
                let result = await multichain.EVM.getInstance(
                    chainID,
                ).sendSignedTransaction(operation.task.signedPayloads[0])
            }
            // Non EVM Section has more complexity
            else {
                console.log("NON EVM PAY")
                // ANCHOR Ripple
                if (operation.chain == "xrpl") {
                    // Testnet support
                    let rpc_url = "https://s1.ripple.com:51234/"
                    if (operation.subchain == "testnet") {
                        rpc_url = "https://s.altnet.rippletest.net:51234/"
                    }
                    console.log("XRP PAY") // TODO
                    let xrplInstance = new multichain.XRPL(rpc_url)
                    let result = await xrplInstance.sendTransaction(
                        operation.task.signedPayloads[0],
                    )
                }
            }

            // FIXME Find a way to standardize the calls as they have the same name across chains (except for EVM) (e.g. sendSignedTransaction)
        }

        // TODO
        return result
    }
}

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
