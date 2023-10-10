// INFO In this module is offloaded the parsing of XM requests
import * as multichain from "sdk/localsdk/multichain"
import sendSigned from "./writes/sendSigned"
import * as fs from "fs"

// REVIEW Define XMScript (chs) class?

export interface ITask {
    type: string;
    params: {};
    // TODO AND NOTE
    // Here the client should send 
    // the signed transactions that it requires
    signedPayloads: any[]; 
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
    chain: string;
    subchain: string;
    is_evm: boolean;
    rpc: string;
    task: ITask;
}

export interface old_XMScript {
    operations: IOperation[];
}

export interface XMScript {
    "multichain_operation": { [key: string]: IOperation };
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
        let script = fullscript.multichain_operation
        // Preparing the result
        // let result: Map<string, any> = new Map<string, any>()
        let array_result: any[] = [] // REVIEW We can use this not named array as a backup while fixing the fixme
        // Iterating over the operations 
        // TODO Allow for conditionals (store & sort? etc)

        for (let i = 0; i < Object.keys(script).length; i++) {
            // Calling them by name
            let funcName = Object.keys(script)[i]
            console.log("[XMDebug] Executing: " + funcName)
            let operation = script[funcName] // FIXME Here and hopefully jus here we got to get the name of the task to store results
            // INFO Executing the operation
            console.log(operation)
            let {task} = operation
            let current_result: [boolean, any]
            // TODO Execute the operation
            switch (task.type) {
                // REVIEW A shy approach to make it work for writes
                case "signedPayload":
                    // FIXME Check connection to the chain and sned it too
                    current_result = await sendSigned(operation)
                    break
                default:
                    current_result = [false, "The operation requested is unknown"]
            }
            // (see FIXME above above) result.set(operation_name, current_result)
            array_result.push(current_result)
        }
        return array_result
    }


}

export default XMParser