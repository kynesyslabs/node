// INFO Entry point for multichain requests
import XMParser from "./XMParser"
import { XMScript } from "./XMParser"
import multichain from "sdk/localsdk/multichain"
import Transaction from "src/libs/blockchain/transaction"
import { Operation } from "src/libs/blockchain/routines/executeOperations"
import Mempool from "src/libs/blockchain/mempool"
import GLS from "src/libs/blockchain/gls/gls"
import { createOperation, createTransaction } from "src/libs/utils/demos_std"

export default class multichainDispatcher {

    // INFO Digesting the request from the server
    static async digest(data: XMScript): Promise<any> {
		
    }

    // INFO Check syntax of xM Script
    static async load(script: string): Promise<any> {
        // TODO String to XMScript
        return await XMParser.load(script)
    }

    // INFO Executes a xM Script
    static async execute(script: XMScript): Promise<any> {
        let results = await XMParser.execute(script)
        // Inserting in mempool the results
        multichainDispatcher.deriveMempoolOperation(
            script,
            results,
            true,
        )
        return results // REVIEW is this ok?
    }

    static async deriveMempoolOperation(
        script: XMScript,
        results: any[],
        insert: boolean = true,
    ): Promise<any> {
        // We should have a valid, attested request: lets handle it
        let derivedTx: Transaction
        let derivedOperation: Operation
        // NOTE If all the attestations are valid we can create the transaction, insert it and gibe back the result
        // Creating a tx from the completed request if is possible
        derivedTx = await createTransaction(script)
        // Deriving an operation from the tx
        derivedOperation = await createOperation(derivedTx)
        if (insert) {
            // Inserting the operation in the next mempool session with the proper data
            Mempool.addTransaction(derivedTx)
            // And we do the same for the derived operation in the GLS
            GLS.getInstance().operations.push(derivedOperation)
        }
        return derivedTx
    }
}