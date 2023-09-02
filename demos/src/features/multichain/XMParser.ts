// INFO In this module is offloaded the parsing of XM requests

// TODO Define XMScript (chs) class
export interface XMScript {

}

class XMParser {
	
    // INFO Transforming a string in a XMScript
    static async load(script: string): Promise<XMScript> {
        let xmscript = null
        // TODO Implement
        return xmscript
    }

    
    static async execute(script: XMScript): Promise<any> {
        // TODO Implement
    }


}

export default XMParser