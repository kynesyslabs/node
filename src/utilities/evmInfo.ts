import * as fs from "fs"
import * as path from "path"

export interface EVMInfo {
    name: string
    chain: string
    id: number
    providers: string[]
    features: string[]
    nativeCurrency: any
}

export default function evmInfo(chainID: number): [boolean, string | EVMInfo] {
    let composedName = "eip155-" + String(chainID) + ".json"
    let filePath = "data/evmChains/" + composedName
    console.log(composedName)
    // Check if the file exists
    if (fs.existsSync(filePath)) {
        console.log("File exists")
        // Read the file
        let rawdata = fs.readFileSync(filePath)
        // Parse the file
        let data = JSON.parse(rawdata.toString())
        let info: EVMInfo = {
            name: data.name,
            chain: data.chain,
            id: data.chainId,
            providers: data.rpc,
            features: data.features,
            nativeCurrency: data.nativeCurrency,
        }
        console.log(info)
        // Return the data
        return [true, info]
    } else {
        console.log("ChainID not found")
        // Return an error
        return [false, "ChainID not found"]
    }
}

evmInfo(1)
