/* eslint-disable no-unused-vars */
import {
    DerivableNative, deriveMempoolOperation,
} from "src/libs/utils/demostdlib/deriveMempoolOperation"
// INFO Entry point for multichain requests
import { json } from "stream/consumers"

import XMParser, { XMScript } from "./routines/XMParser"

export default class multichainDispatcher {
    // INFO Digesting the request from the server
    static async digest(data: XMScript): Promise<any> {
        console.log("\n\n")
        console.log("[XM Script full digest]")
        console.log(data)
        console.log("Stringed to:")
        console.log(JSON.stringify(data))
        console.log("\n\n")
        console.log("[XMChain Digestion] Processing multichain operation")
        console.log(data.operations)
        console.log("\n[XMChain Digestion] Having:")
        console.log(Object.keys(data.operations).length)
        console.log("operations")

        console.log("\n===== ANALYSIS ===== \n")
        console.log("\n===== FUNCTIONS ===== \n")
        for (
            let i = 0;
            i < Object.keys(data.operations).length;
            i++
        ) {
            // Named function
            console.log(
                "[XMChain Digestion] Found: " +
                    Object.keys(data.operations)[i],
            )
        }
        console.log("\n===== END OF ANALYSIS ===== \n")
        console.log("[XMChain Digestion] Proceeding: execution phase")
        // REVIEW Execute
        let result = await multichainDispatcher.execute(data)
        // TODO Implement a response schema
        return JSON.stringify(result, (_, v) =>
            typeof v === "bigint" ? v.toString() : v,
        ) // await multichainDispatcher.execute(data)
    }

    // INFO Check syntax of xM Script
    static async load(script: string): Promise<any> {
        // TODO String to XMScript
        return await XMParser.load(script)
    }

    // INFO Executes a xM Script
    static async execute(script: XMScript): Promise<any> {
        let results = []
        console.log("[XM EXECUTE]: Script")
        console.log(JSON.stringify(script))
        results = await XMParser.execute(script)
        console.log("[XM EXECUTE] Successfully executed")
        console.log(results)


        console.log("[XM EXECUTE] Derived Operation completed successfully")
        //console.log(derivedOperation)

        console.log("[XM EXECUTE] Sending back the result")
        console.log(results)

        return results
    }
}