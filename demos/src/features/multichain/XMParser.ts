// INFO In this module is offloaded the parsing of XM requests
import multichain from "sdk/localsdk"
import sendSigned from "./routines/writes/sendSigned"

// SECTION Payloads signing
/* NOTE To better explain:
 * Once a request is received from the node, it sometimes needs data to be authenticated.
 * For example, any transaction changing status (transfers, things requiring gas, etc.) needs
 * to be properly signed. To avoid storing the private keys on the node, the node will ask
 * the client to sign locally the produced transactions. DEMOS will then be able to relay the
 * said transactions without security implications.
*/
export interface IXMPayload {
    toSign: string,
    signature: any, // REVIEW Use another type?
    publicKey: string, // REVIEW Use another type?
}

export interface IXMPayloadRequest {
    operationIdentifier: string, // Identifies the XMChain operation we are referring to
    payloads: IXMPayload[], // Array of payloads to be signed for the operation
} 
// !SECTION Payloads signing

// REVIEW Define XMScript (chs) class?

export interface ITask {
    type: string;
    params: {};
    // TODO AND NOTE
    // Here the client should send 
    // the signed transactions that it requires
    signedPayloads: any[]; 
}

export interface IOperation {
    chain: string;
    subchain: string;
    is_evm: boolean;
    rpc: string;
    task: ITask;
}

export interface XMScript {
    operations: IOperation[];
}

class XMParser {
	
    // INFO Transforming a string in a XMScript
    static async load(script: string): Promise<XMScript> {
        let xmscript: XMScript = JSON.parse(script)
        return xmscript
    }

    
    static async execute(script: XMScript): Promise<any> {
        // Preparing the result
        // let result: Map<string, any> = new Map<string, any>()
        let array_result: any[] = [] // REVIEW We can use this not named array as a backup while fixing the fixme
        // Iterating over the operations 
        // TODO Allow for conditionals (store & sort? etc)
        for (let i = 0; i < script.operations.length; i++) {
            let operation = script.operations[i] // FIXME Here and hopefully jus here we got to get the name of the task to store results
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
            /* NOTE && TODO 
             * For reasons linked to the NOTE at the beginning of this file,
             * The reply could contain instances of the IXMPayloadRequest class.
             * These payloads need to be acknowledged by the client (so in the client code).
             * Please see the client implementation for more details on how this is done.
             * Anyway, the client should be able to reply something that is in line with the
             * IXMPayloadRequest class as described in the documentation.
            */
            array_result.push(current_result)
        }
        // TODO Implement
    }


}

export default XMParser