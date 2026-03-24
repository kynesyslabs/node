import log from "@/utilities/logger"

// INFO forgeBuffer comes in as the raw result of forge methods
export function forgeToHex(forgeBuffer: Uint8Array | Buffer | { type: string; data: number[] }): string {
    try {
        if ((forgeBuffer as { type?: string }).type === "Buffer") {
            forgeBuffer = (forgeBuffer as { data: number[] }).data as unknown as Uint8Array
        }
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        log.debug(`[ForgeToHex] Not a buffer: ${errorMsg}`)
    }
    return Buffer.from(forgeBuffer as Uint8Array).toString("hex")
}

// INFO finalArray must come out as an acceptable input for forge methods
// NOTE The above and the below must be revertible with each other
export function hexToForge(forgeString: string): Uint8Array {
    const ED25519_KEY_SIZE = 64
    const ED25519_HALF_KEY = 32
    const keyBytes = new Uint8Array(ED25519_KEY_SIZE)
    for (let i = 0; i < forgeString.length; i += 2) {
        const hexValue = forgeString.substring(i, i + 2)
        keyBytes[i / 2] = parseInt(hexValue, 16)
    }
    // Remove trailing zeroes
    // TODO Find a better solution as this trims also the last byte(s) if it's 0
    let trimmedArray = keyBytes.slice()
    while (trimmedArray[trimmedArray.length - 1] === 0) {
        trimmedArray = trimmedArray.slice(0, -1)
    }
    // Pad back if trimming removed a legitimate zero byte
    const expectedLength = ED25519_KEY_SIZE - 1
    const expectedHalfLength = ED25519_HALF_KEY - 1
    if (trimmedArray.length === expectedLength || trimmedArray.length === expectedHalfLength) {
        log.warning(`[HexToForge] Suspicious length: ${trimmedArray.length}`)
        const paddedArray = new Uint8Array(trimmedArray.length + 1)
        paddedArray.set(trimmedArray)
        trimmedArray = paddedArray
    }
    return trimmedArray
}
