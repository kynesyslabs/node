// INFO Entry point for multichain requests
import XMParser from "./XMParser"
import { XMScript } from "./XMParser"


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
        return await XMParser.execute(script)
    }
	
}