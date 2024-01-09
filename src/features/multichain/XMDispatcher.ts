/* eslint-disable no-unused-vars */
// INFO Entry point for multichain requests
import { json } from "stream/consumers"
import XMParser from "./routines/XMParser"
import { XMScript } from "./routines/XMParser"
import {
    DerivableNative,
    deriveMempoolOperation,
} from "src/libs/utils/demostdlib/deriveMempoolOperation"

export default class multichainDispatcher {
    // INFO Digesting the request from the server
    static async digest(data: XMScript): Promise<any> {
        console.log("[XMChain Digestion] Processing operation")
        ////console.log(data.multichain_operation)
        console.log("\n===== FUNCTIONS ===== \n")
        for (
            let i = 0;
            i < Object.keys(data.multichain_operation).length;
            i++
        ) {
            // Named function
            console.log(
                "[XMChain Digestion] Found: " +
                    Object.keys(data.multichain_operation)[i],
            )
        }
        console.log("\n===== END OF ANALYSIS ===== \n")
        console.log("[XMChain Digestion] Proceeding: execution phase")
        // REVIEW Execute
        let result = await multichainDispatcher.execute(data)
        // TODO Implement a response schema
        return JSON.stringify(result) // await multichainDispatcher.execute(data)
    }

    // INFO Check syntax of xM Script
    static async load(script: string): Promise<any> {
        // TODO String to XMScript
        return await XMParser.load(script)
    }

    // INFO Executes a xM Script
    static async execute(script: XMScript): Promise<any> {
        let results = await XMParser.execute(script)

        console.log("[XM EXECUTE] Successfully executed: result is")
        console.log(results)

        // Inserting in mempool the results
        let derivedOperation = await multichainDispatcher.deriveMempoolOperation(
            script,
            results,
            true,
        )

        console.log("[XM EXECUTE] Derived Operation is:")
        console.log(derivedOperation)

        let overallResult = {
            results: results,
            derivedOperation: derivedOperation, // FIXME It does not contain the result
        }

        
        console.log("[XM EXECUTE] Result to send back:")
        console.log(overallResult)
        
        return overallResult

    }

    static async deriveMempoolOperation(
        script: XMScript,
        results: any[],
        insert: boolean = true,
    ): Promise<any> {
        // We should have a valid, attested request: lets handle it
        // NOTE If all the attestations are valid we can create the transaction, insert it and give back the result
        // Creating a tx from the completed request if is possible
        let jsonNote = {
            script: script,
            results: results,
        }

        console.log(jsonNote)

        return await deriveMempoolOperation(jsonNote as any, insert)
    }
}
