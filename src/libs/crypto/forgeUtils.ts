// INFO forgeBuffer comes in as the raw result of forge methods
export function ForgeToHex(forgeBuffer: any) {
    //console.log(forgeBuffer)
    let rebuffer = Buffer.from(forgeBuffer)
    forgeBuffer = rebuffer.toString("hex")
    return "0x" + forgeBuffer
}

// INFO finalArray must come out as an acceptable input for forge methods
// NOTE The above and the below must be revertible with each other
export function HexToForge(forgeString: string) {
    /*if (forgeString.startsWith("0x")) {
        forgeString = forgeString.slice(2)
    }*/
    let finalArray = new Uint8Array(64)
    console.log("[string to forge encoded]")
    //console.log(forgeString)
    for (let i = 0; i < forgeString.length; i += 2) {
        const hexValue = forgeString.substr(i, 2)
        const decimalValue = parseInt(hexValue, 16)
        finalArray[i / 2] = decimalValue
    }
    // Remove trailing zeros
    while (finalArray[finalArray.length - 1] == 0) {
        finalArray = finalArray.slice(0, -1)
    }
    console.log("[HexToForge] Encoded into an Uint8Array of lenght: " + finalArray.length)
    //console.log(finalArray)
    return finalArray
}
