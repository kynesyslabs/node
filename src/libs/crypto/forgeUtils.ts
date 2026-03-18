import log from "@/utilities/logger"

// INFO forgeBuffer comes in as the raw result of forge methods
export function forgeToHex(forgeBuffer: any): string {
    try {
        if (forgeBuffer.type == "Buffer") {
            forgeBuffer = forgeBuffer.data
        }
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        log.debug(`[ForgeToHex] Not a buffer: ${errorMsg}`)
    }
    //console.log(forgeBuffer)
    const rebuffer = Buffer.from(forgeBuffer)
    forgeBuffer = rebuffer.toString("hex")
    return forgeBuffer
}

// INFO finalArray must come out as an acceptable input for forge methods
// NOTE The above and the below must be revertible with each other
export function hexToForge(forgeString: string): Uint8Array {
    /*if (forgeString.startsWith("0x")) {
        forgeString = forgeString.slice(2)
    }*/
    const finalArray = new Uint8Array(64)
    //console.log("[string to forge encoded]")
    //console.log(forgeString)
    for (let i = 0; i < forgeString.length; i += 2) {
        const hexValue = forgeString.substr(i, 2)
        const decimalValue = parseInt(hexValue, 16)
        finalArray[i / 2] = decimalValue
    }
    // Remove trailing zeroes
    // TODO Find a better solution as this trims also the last byte(s) if it's 0
    let trimmedArray = finalArray
    while (trimmedArray[trimmedArray.length - 1] == 0) {
        trimmedArray = trimmedArray.slice(0, -1)
    }
    // NOTE This is an horrible, yet working solution to the above problem
    if (trimmedArray.length == 63 || trimmedArray.length == 31) {
        log.warning("[HexToForge] Suspicious length: " + trimmedArray.length)
        const finalArray = new Uint8Array(trimmedArray.length + 1)
        for (let i = 0; i < trimmedArray.length; i++) {
            finalArray[i] = trimmedArray[i]
        }
        trimmedArray = finalArray
    }
    //console.log("[HexToForge] Encoded into an Uint8Array of lenght: " + finalArray.length)
    //console.log(trimmedArray)
    return trimmedArray
}
