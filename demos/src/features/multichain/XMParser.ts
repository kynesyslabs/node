// INFO In this module is offloaded the parsing of XM requests

// TODO Define XMScript (chs) class

export interface ITask {
    type: string;
    params: {};
}

export interface IOperation {
    chain: string;
    subchain: string;
    is_evm: boolean;
    rpc: string;
    task: ITask
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
            let current_result: any // TODO Execute the operation
            // (see FIXME above above) result.set(operation_name, current_result)
            array_result.push(current_result)
        }
        // TODO Implement
    }


}

export default XMParser