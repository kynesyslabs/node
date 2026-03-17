import * as fs from "fs"
import * as path from "path"
import log from "src/utilities/logger"

export interface EVMInfo {
    name: string
    chain: string
    id: number
    providers: string[]
    features: string[]
    nativeCurrency: any
}

export default function evmInfo(chainID: number): [boolean, string | EVMInfo] {
    const composedName = "eip155-" + String(chainID) + ".json"
    const filePath = "data/evmChains/" + composedName
    log.debug(composedName)
    // Check if the file exists
    if (fs.existsSync(filePath)) {
        log.debug("File exists")
        // Read the file
        const rawdata = fs.readFileSync(filePath)
        // Parse the file
        const data = JSON.parse(rawdata.toString())
        const info: EVMInfo = {
            name: data.name,
            chain: data.chain,
            id: data.chainId,
            providers: data.rpc,
            features: data.features,
            nativeCurrency: data.nativeCurrency,
        }
        log.debug(info)
        // Return the data
        return [true, info]
    } else {
        log.debug("ChainID not found")
        // Return an error
        return [false, "ChainID not found"]
    }
}

evmInfo(1)
